# Agent Group Chat — 设计文档

> 版本：v0.1  日期：2026-11-04  状态：待开发

---

## 1. 项目目标

一个**群聊式多角色 AI 协作平台**。你当群主，多个 AI 角色当你的团队成员，在一个类似微信群/Slack 的界面里协作干活。

**核心体验**：
- 打开网页 → 选一个群（项目）→ 发消息 → 多个 AI 角色按分工协作回复
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
│  - 群列表 / 聊天窗口 / 群公告编辑 / 角色管理        │
│  - 通过 WebSocket 连本地后端                     │
└────────────────────┬────────────────────────────┘
                     │ ws://localhost:8787
┌────────────────────▼────────────────────────────┐
│  本地后端（Node.js 脚本，用户本地跑）              │
│  - Express HTTP API（群/消息/角色 CRUD）           │
│  - WebSocket 实时推送（新消息广播）                │
│  - 角色 Worker：监听消息 → 调 opencode → 回消息    │
│  - opencode 连接器：spawn 本地 opencode CLI        │
└────────────────────┬────────────────────────────┘
                     │ child_process
┌────────────────────▼────────────────────────────┐
│  opencode CLI（用户已安装）                       │
│  在项目文件夹里读写文件、跑命令                     │
└─────────────────────────────────────────────────┘
```

**为什么前端放 GitHub Pages、后端放本地？**
- 前端是纯静态页面，部署在 GitHub Pages 上，打开链接就能用
- 后端必须跑在你本机，因为要调用本地的 opencode（浏览器安全沙箱不允许）
- 前端页面可配置后端地址（默认 `http://localhost:8787`），也可以用本地后端自带的静态页

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
        ├── messages.jsonl      # 聊天记录（追加写，每行一条 JSON）
        └── contexts/
            ├── product-manager.jsonl    # PM 的独立对话历史
            ├── software-architect.jsonl  # 架构师的独立对话历史
            └── ux-researcher.jsonl      # 设计师的独立对话历史
```

**项目文件夹**（角色干活的地方）跟群目录是分开的，由群配置里的 `projectDir` 字段指定。

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
（完整的 system prompt，跟 agency-agents 里的格式一样）
```

**frontmatter 解析**：自己写个简单的（不用 js-yaml，frontmatter 结构简单），参考 `agency-orchestrator/src/agents/loader.ts`。

---

## 7. 消息路由逻辑（核心）

用户在群里发一条消息后，后端怎么决定哪个角色回复？

```
收到用户消息
  ↓
广播给群里所有角色 worker
  ↓
每个角色 worker 独立判断：
  ① 我被 @了吗？ → 是 → 必须回
  ② 消息是其他角色发的，且 @了我？ → 是 → 必须回
  ③ 都不是 → 自主判断：
     构建 prompt 时告诉角色：
     "如果这条消息跟你的职责无关，只回复 [SKIP]，不要多说"
     调 opencode 看输出是不是 [SKIP]
  ↓
决定要回 → 构建完整上下文 → 调 opencode → 把结果发回群
```

**为什么用 [SKIP] 而不是两次调用？**
- 一次调用搞定判断 + 回复，省一次 API 费
- prompt 里明确告诉角色：不相关就回 [SKIP]，相关就直接输出回复

---

## 8. opencode 调用方式

从 `agency-orchestrator/src/connectors/opencode-cli.ts` 抄过来，改成 Node.js 原生：

```typescript
// 调用方式
const proc = spawn('opencode', [
  'run', '--format', 'json',
  '--dir', projectDir,        // 项目文件夹，角色在这里面读写文件
  prompt                       // 完整 prompt
]);

// 解析 NDJSON 输出
// 每行一个 JSON 对象，type==="text" 的事件里 part.text 就是输出内容
// 把所有 text 事件按顺序拼接，就是最终回复
```

**关键细节**（从 AO 源码确认的）：
- `opencode run --format json` 输出 NDJSON 事件流
- 答案在 `type: "text"` 事件的 `part.text`（可能多段，按顺序拼）
- `--dir` 指定工作目录，角色在这个目录里读写文件
- system prompt 走 stdin 传入（或者拼在 prompt 里）

---

## 9. 角色上下文管理

每个角色的独立对话历史怎么维护？

```
角色 worker 准备调 opencode 时：
  1. 读取自己的 contexts/<角色名>.jsonl（最近 20 条）
  2. 读取群公告 announcement.md（协作规则）
  3. 读取全局角色定义 roles/<角色名>.md（system prompt）
  4. 拼接成完整 prompt：
     [角色 system prompt]
     [群公告/协作规则]
     [最近的群聊历史摘要]
     [本次用户消息]
  5. 调 opencode
  6. 把「用户消息 + 角色回复」追加到自己的 contexts/<角色名>.jsonl
```

**为什么不把全量群聊历史都塞给角色？**
- 每个角色只关心跟自己相关的上下文
- 最近 20 条足够，太长会浪费 token
- 角色之间不共享完整历史，只有用户能看到全量

---

## 10. API 设计

后端提供以下 HTTP 接口（前端用）：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/groups` | GET | 列出所有群 |
| `/api/groups` | POST | 创建群（名 + 项目文件夹路径） |
| `/api/groups/:name` | GET | 群详情（配置 + 成员） |
| `/api/groups/:name/messages` | GET | 拉取消息历史（分页） |
| `/api/groups/:name/messages` | POST | 发消息（用户发的） |
| `/api/groups/:name/announcement` | GET/PUT | 读/写群公告 |
| `/api/groups/:name/members` | GET/POST/DELETE | 列出/添加/移除群成员角色 |
| `/api/roles` | GET | 列出所有可用角色（全局角色库） |
| `/ws` | WebSocket | 实时推送新消息 |

---

## 11. 前端设计

**页面结构**（单页应用，无框架）：

```
┌──────────┬──────────────────────────┬──────────┐
│ 左侧栏    │ 中间聊天窗口              │ 右侧栏   │
│          │                          │          │
│ 群列表    │ 消息流（滚动）            │ 群公告    │
│ - 群A    │  用户: 帮我做记账工具...   │ (可编辑) │
│ - 群B    │  🧭PM: 收到，我先拆需求   │          │
│          │  🏗️架构师: 技术评估...     │ 成员列表  │
│          │                          │ - PM ✓   │
│ ──────  │                          │ - 架构师 ✓│
│ 角色库    │ ──────────────────      │ - 设计师  │
│ (可点选)  │ [输入框]              [发送]│          │
└──────────┴──────────────────────────┴──────────┘
```

**UI 参考**：SwarmChat 的 web viewer 设计（Slack 风格），但我们自己写，不用它的代码。
用纯 HTML + CSS + 原生 JS，单文件 `index.html`。

---

## 12. 开发计划（分阶段，每步可跑）

### Phase 1：基础框架（本地能跑通聊天）
- [ ] Express 服务器 + WebSocket
- [ ] 消息存储（JSONL 读写）
- [ ] 简单前端页面（能发消息、能看消息）
- [ ] 群创建/列表

**验收**：本地跑 `npm start`，浏览器打开 localhost:8787，能发消息能看到消息。

### Phase 2：角色系统 + opencode 连接器
- [ ] 角色定义加载（.md 文件解析）
- [ ] opencode 连接器（spawn + NDJSON 解析）
- [ ] 群成员管理（加角色/删角色）
- [ ] 角色 worker 框架（收到消息 → 调 opencode → 发回群）

**验收**：建一个群，加 PM 角色，发消息后 PM 能通过 opencode 回复。

### Phase 3：消息路由 + 上下文管理
- [ ] @ 解析（识别消息里的 @角色名）
- [ ] [SKIP] 自主判断逻辑
- [ ] 角色独立上下文（contexts/<角色>.jsonl）
- [ ] 群公告注入 prompt

**验收**：多角色在一个群里，用户发一条消息，只有相关角色回复，不相关的回 [SKIP] 不发出来。

### Phase 4：前端美化 + 群管理
- [ ] 群公告编辑界面
- [ ] 成员管理界面（加角色/删角色）
- [ ] 消息流美化（头像、时间、@高亮）
- [ ] 左侧群列表

**验收**：完整的聊天界面，像 Slack 一样好用。

### Phase 5：部署到 GitHub Pages
- [ ] 前端静态构建到 `docs/` 目录
- [ ] 配置 GitHub Pages 部署
- [ ] 前端可配置后端地址（默认 localhost:8787）

**验收**：打开 GitHub Pages 链接，能连本地后端，正常聊天。

---

## 13. 从现有项目拿什么

| 模块 | 来源 | 怎么拿 |
|------|------|--------|
| 角色定义文件（PM、架构师等） | agency-orchestrator/agency-agents/ | 直接复制几个 .md 文件过来，格式完全一样 |
| opencode 调用 + NDJSON 解析 | agency-orchestrator/src/connectors/opencode-cli.ts | 抄核心逻辑，改成 ESM 写法 |
| 角色 frontmatter 解析 | agency-orchestrator/src/agents/loader.ts | 抄 parseAgentFile 函数 |
| 聊天 UI 设计 | swarmchat web viewer | 参考布局和交互，自己写（不依赖它的代码） |
| DAG 工作流引擎 | agency-orchestrator/src/core/dag.ts | **不拿**，我们是群聊模式不是流水线 |

---

## 14. 不做什么（MVP 边界）

- 不做多用户/登录鉴权（本地单人用）
- 不做文件附件（先只支持文本消息）
- 不做线程回复（先只有平消息流）
- 不做 DAG 工作流编排（群聊是自由对话，不是流水线）
- 不做云端同步（所有数据本地文件）
- 不做图片/视频/TTY（先纯文本）

---

## 15. 待确认问题

1. **角色 worker 是常驻进程还是按需启动？**
   - 常驻：每个群的每个角色跑一个后台进程，一直监听
   - 按需：收到消息时临时启动，跑完就退出
   - 建议：常驻（响应快），但要考虑多群多角色的进程数量

2. **前端要不要支持「不连本地后端」的纯浏览模式？**
   - 纯浏览模式：只看消息历史，不能发消息
   - 还是必须连后端才能看？
   - 建议：必须连后端（数据都在本地）

3. **opencode 的 system prompt 怎么传？**
   - AO 里是走 stdin 包装 `<system>...</system>`
   - 我们也照这个方式？
   - 建议：照 AO 的方式，已经验证过能用
