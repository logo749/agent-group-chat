# Agent Group Chat — 设计文档

> 版本：v0.2  日期：2026-11-05  状态：Phase 1 开发中

---

## 1. 项目目标

一个**群聊式多角色 AI 协作平台**。你当群主，多个 AI 角色当你的团队成员，在一个类似微信群/Slack 的界面里协作干活。

**核心体验**：
- 打开网页 → 配置后端地址 → 选一个群（项目）→ 发消息 → 多个 AI 角色按分工协作回复
- 每个群对应一个本地项目文件夹，角色通过 opencode 直接在文件夹里读写文件、跑命令
- 你能看到所有角色的对话过程，角色之间通过 @ 互相协作

---

## 2. 核心概念

| 概念 | 说明 | 存储位置 |
|------|------|----------|
| **群（Group）** | 一个项目，一个聊天窗口 | `~/.agc/groups/<群名>/` |
| **角色（Agent）** | 一个 AI 专家（产品经理、架构师…），由 .md 文件定义 | `~/.agc/roles/<角色名>.md` |
| **消息（Message）** | 群里的一条消息，有发送者、内容、时间 | 群目录下 `messages.jsonl` |
| **群公告（Announcement）** | 协作规则，注入每个角色的 system prompt | 群目录下 `announcement.md` |
| **角色上下文** | 每个角色独立的对话历史（角色之间不共享） | 群目录下 `contexts/<角色名>.jsonl` |
| **项目文件夹** | 角色干活的地方（读写文件、跑命令） | 用户指定的任意路径 |

---

## 3. 技术架构

```
┌─────────────────────────────────────────────────┐
│  前端（GitHub Pages 部署）                        │
│  纯 HTML + CSS + 原生 JS，无框架                  │
│  - 首次打开：配置后端地址页（存 localStorage）     │
│  - 群列表 / 聊天窗口 / 群公告编辑 / 角色管理        │
│  - 通过 WebSocket 连本地后端                     │
└────────────────────┬────────────────────────────┘
                     │ ws://localhost:8787
┌────────────────────▼────────────────────────────┐
│  本地后端（Node.js 脚本，用户本地跑）              │
│  - Express HTTP API（群/消息/角色 CRUD）           │
│  - WebSocket 实时推送（新消息广播）                │
│  - 角色 Worker（常驻进程）：监听消息 → 调 opencode │
│  - opencode 连接器：spawn 本地 opencode CLI        │
└────────────────────┬────────────────────────────┘
                     │ child_process
┌────────────────────▼────────────────────────────┐
│  opencode CLI（用户已安装）                       │
│  在项目文件夹里读写文件、跑命令                     │
└─────────────────────────────────────────────────┘
```

---

## 4. 目录结构

```
~/.agc/                          # 数据根目录
├── config.json                  # 全局配置（端口、默认角色库路径）
├── roles/                       # 全局角色库
│   ├── product-manager.md
│   ├── software-architect.md
│   └── ux-researcher.md
└── groups/
    └── 记账工具项目/
        ├── group.json           # 群配置：群名、成员列表、项目文件夹路径
        ├── announcement.md     # 群公告（协作规则）
        ├── messages.jsonl       # 聊天记录（追加写，每行一条 JSON）
        └── contexts/
            ├── product-manager.jsonl    # PM 的独立对话历史
            ├── software-architect.jsonl  # 架构师的独立对话历史
            └── ux-researcher.jsonl      # 设计师的独立对话历史
```

---

## 5. 消息格式

每条消息一行 JSON（JSONL 追加写）：

```json
{
  "id": "msg_001",
  "from": "product-manager",
  "fromType": "user | agent | system",
  "text": "收到。我先拆需求...",
  "at": "2026-11-04T15:30:00.000Z",
  "mentions": ["software-architect"],
  "replyTo": "msg_000"
}
```

---

## 6. 角色定义格式

复用 agency-orchestrator 的格式（从现有项目拿）：

```markdown
---
name: 产品经理
description: 负责需求拆解、产品规划、优先级排序
emoji: 🧭
---

你是 Alex，一名资深产品经理...
（完整的 system prompt）
```

---

## 7. 消息路由逻辑（核心）

```
收到用户消息
  ↓
广播给群里所有常驻角色 worker
  ↓
每个角色 worker 独立判断：
  ① 我被 @了吗？ → 是 → 必须回
  ② 消息是其他角色发的，且 @了我？ → 是 → 必须回
  ③ 都不是 → 自主判断：
     prompt 里告诉角色："如果跟你无关，只回复 [SKIP]"
     调 opencode 看输出是不是 [SKIP]
  ↓
决定要回 → 构建完整上下文 → 调 opencode → 把结果发回群
```

---

## 8. opencode 调用方式

从 `agency-orchestrator/src/connectors/opencode-cli.ts` 抄过来，改成 Node.js 原生：

```typescript
// 命令行参数
opencode run --format json --dir <项目目录> "<用户消息>"

// stdin 传入 system prompt 内容
// stdin 内容格式（照 AO 的方式）：
//   <system>
//   角色定义（system prompt 正文）
//   群公告（协作规则）
//   </system>
//   最近的群聊历史

// NDJSON 输出解析：
// 每行一个 JSON 对象，type==="text" 的事件里 part.text 就是输出内容
// 把所有 text 事件按顺序拼接，就是最终回复
```

**关键细节**（从 AO 源码确认）：
- `opencode run --format json` 输出 NDJSON 事件流
- 答案在 `type: "text"` 事件的 `part.text`（可能多段，按顺序拼）
- `--dir` 指定工作目录，角色在这个目录里读写文件
- system prompt 走 stdin 传入，用户消息作为命令行参数

---

## 9. 角色上下文管理

每个角色 worker 是**常驻进程**，一直监听群消息：

```
角色 worker 启动时：
  1. 读取角色定义 roles/<角色名>.md → systemPrompt
  2. 读取群公告 announcement.md → groupRules
  3. 连接 WebSocket，监听本群的新消息

收到新消息时：
  1. 判断是否需要回复（@ 或自主判断）
  2. 读取自己的 contexts/<角色名>.jsonl（最近 20 条）→ 历史上下文
  3. 拼接完整 prompt：
     [system prompt 段：角色设定 + 群公告]
     [最近群聊历史]
     [本次用户消息]
  4. 调 opencode（--dir 项目目录）
  5. 输出不是 [SKIP] → 发回群
  6. 把「用户消息 + 角色回复」追加到自己的 contexts/<角色名>.jsonl
```

---

## 10. API 设计

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/groups` | GET | 列出所有群 |
| `/api/groups` | POST | 创建群（名 + 项目文件夹路径） |
| `/api/groups/:name` | GET | 群详情（配置 + 成员） |
| `/api/groups/:name/messages` | GET | 拉取消息历史（分页） |
| `/api/groups/:name/messages` | POST | 发消息（用户发的） |
| `/api/groups/:name/announcement` | GET/PUT | 读/写群公告 |
| `/api/groups/:name/members` | GET/POST/DELETE | 列出/添加/移除群成员角色 |
| `/api/roles` | GET | 列出所有可用角色 |
| `/ws` | WebSocket | 实时推送新消息 |

---

## 11. 前端设计

**首次打开**：配置后端地址页（输入 `http://localhost:8787`，存 localStorage）

**主界面**（Slack 风格三栏）：

```
┌──────────┬──────────────────────────┬──────────┐
│ 左侧栏    │ 中间聊天窗口              │ 右侧栏   │
│ 群列表    │ 消息流（滚动）            │ 群公告    │
│ 角色库    │ 输入框 + 发送按钮          │ 成员列表  │
└──────────┴──────────────────────────┴──────────┘
```

---

## 12. 开发计划（分阶段，每步可跑）

### Phase 1：基础框架（本地能跑通聊天）✅ 进行中
- [x] 项目初始化（package.json / tsconfig）
- [ ] Express 服务器 + WebSocket
- [ ] 消息存储（JSONL 读写）
- [ ] 简单前端页面（能发消息、能看消息）
- [ ] 群创建/列表 API

### Phase 2：角色系统 + opencode 连接器
- [ ] 角色定义加载（.md 文件解析）
- [ ] opencode 连接器（spawn + NDJSON 解析）
- [ ] 群成员管理 API
- [ ] 角色 worker 框架（常驻进程）

### Phase 3：消息路由 + 上下文管理
- [ ] @ 解析
- [ ] [SKIP] 自主判断逻辑
- [ ] 角色独立上下文
- [ ] 群公告注入 prompt

### Phase 4：前端美化 + 群管理界面
- [ ] 群公告编辑界面
- [ ] 成员管理界面
- [ ] 消息流美化

### Phase 5：部署到 GitHub Pages
- [ ] 前端静态构建到 `docs/` 目录
- [ ] GitHub Pages 配置
- [ ] 后端地址可配置

---

## 13. 从现有项目拿什么

| 模块 | 来源 | 怎么拿 |
|------|------|--------|
| 角色定义文件（PM、架构师等） | agency-orchestrator/agency-agents/ | 直接复制几个 .md 文件过来 |
| opencode 调用 + NDJSON 解析 | agency-orchestrator/src/connectors/opencode-cli.ts | 抄核心逻辑，改成 ESM |
| 角色 frontmatter 解析 | agency-orchestrator/src/agents/loader.ts | 抄 parseAgentFile 函数 |
| 聊天 UI 设计 | swarmchat web viewer | 参考布局，自己写 |

---

## 14. 不做什么（MVP 边界）

- 不做多用户/登录鉴权（本地单人用）
- 不做文件附件（先只支持文本消息）
- 不做线程回复（先只有平消息流）
- 不做 DAG 工作流编排（群聊是自由对话，不是流水线）
- 不做云端同步（所有数据本地文件）

---

## 15. 已确认决策

| 问题 | 结论 |
|------|------|
| 角色 worker 模式 | **常驻进程**，一直监听群消息 |
| 前端不连后端能看吗？ | **不能**，首次打开是配置后端地址页 |
| opencode system prompt 传参 | 走 **stdin**，照 AO 的 `<system>...</system>` 包装方式 |
