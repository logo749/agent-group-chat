# Agent Group Chat

> 多角色 AI 群聊协作平台 — 你当群主，多个 AI 角色当团队，基于 opencode 在项目文件夹里干活。

[设计文档](./DESIGN.md) · [在线使用（GitHub Pages）](https://logo749.github.io/agent-group-chat/)

---

## 这是什么

一个 Slack 风格的 AI 群聊。群成员不是人，是 AI 专家（产品经理、架构师、前后端开发、测试…）。
你在群里发一句话，@谁谁就回，不 @ 时角色自己判断和自己是否相关，直接在你的项目文件夹里读写文件。

- **一个群 = 一个项目文件夹**（opencode 干活的地方）
- **角色 = AI 专家**（.md 文件定义，含 system prompt）
- **群公告 = 工作流/协作规则**（每次对话自动注入）
- **底层 = 本地 opencode CLI**（用你已配置好的模型和账号）

---

## 功能清单

### 群聊管理
- 新建群：名称 + 项目目录
- 重命名 / 改项目目录
- 删除群（含全部聊天记录，有确认）
- 每个群独立配置、独立消息历史

### 角色管理
- 内置 6 个角色：产品经理、架构师、前端、后端、测试、代码审查
- 新建自定义角色：名称、emoji、关键词、system prompt
- 编辑 / 删除角色（内置角色不可删）
- 角色加入 / 移出群，系统消息提示

### 聊天协作
- `@角色名` 指定回复
- 不提 @ 时，角色根据关键词自主判断是否相关
- 每个角色独立上下文，自动注入群公告 + 历史消息
- 实时状态：思考中 / 回复中 / 出错
- WebSocket 实时推送，多标签同步

---

## 快速开始

### 前置条件
- Node.js >= 20
- 本地已安装 opencode 并完成登录：

```bash
npm install -g opencode-ai
opencode auth login
```

### 启动后端

```bash
git clone https://github.com/logo749/agent-group-chat.git
cd agent-group-chat
npm install

# 开发模式（文件改动自动重启）
npm run dev

# 或编译后运行
npm run build && npm start
```

后端默认跑在 `http://localhost:8787`。

### 使用前端

1. **GitHub Pages（推荐）**：直接打开 https://logo749.github.io/agent-group-chat/ ，输入本地后端地址连接
2. **本地页面**：后端启动后访问 `http://localhost:8787`

---

## 项目结构

```
agent-group-chat/
├── src/
│   ├── server.ts          # Express API + WebSocket 服务器
│   ├── store.ts           # 本地文件存储层
│   ├── agent-runner.ts    # 角色调度器
│   ├── opencode.ts        # opencode CLI 连接器
│   └── types.ts           # 类型定义
├── docs/
│   ├── index.html         # GitHub Pages 正式版前端
│   └── prototype.html     # 纯前端原型
├── roles/                 # 内置角色定义
├── public/                # 本地静态页面
├── DESIGN.md
├── package.json
└── tsconfig.json
```

运行时数据默认在 `~/.agc/`：

```
~/.agc/
├── groups/<group-id>/
│   ├── group.json
│   ├── announcement.md
│   └── messages.jsonl
└── roles/                 # 用户自定义角色
```

---

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 + opencode 状态 |
| GET | `/api/groups` | 群列表 |
| POST | `/api/groups` | 新建群 |
| GET | `/api/groups/:id` | 群详情 |
| PATCH | `/api/groups/:id` | 重命名 / 改目录 |
| DELETE | `/api/groups/:id` | 删除群 |
| GET | `/api/groups/:id/messages` | 消息历史 |
| POST | `/api/groups/:id/messages` | 发消息 |
| GET | `/api/groups/:id/announcement` | 获取公告 |
| PUT | `/api/groups/:id/announcement` | 保存公告 |
| POST | `/api/groups/:id/members` | 添加成员 |
| DELETE | `/api/groups/:id/members/:agentId` | 移除成员 |
| GET | `/api/agents` | 角色列表 |
| POST | `/api/agents` | 新建角色 |
| GET | `/api/agents/:id` | 角色详情 |
| PATCH | `/api/agents/:id` | 编辑角色 |
| DELETE | `/api/agents/:id` | 删除自定义角色 |

WebSocket：`ws://localhost:8787/ws?group=<groupId>`，推送 `message`、`agent_status`、`group_updated`、`group_deleted`。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGC_PORT` | `8787` | 后端端口 |
| `AGC_DATA_DIR` | `~/.agc` | 数据存储目录 |

---

## 角色定义格式

```markdown
---
name: 产品经理
emoji: 🧭
description: 需求 PRD 产品规划
---

你是一位资深产品经理，负责需求梳理、PRD 编写……
```

内置角色在项目 `roles/`，自定义角色在 `~/.agc/roles/`，同名时自定义覆盖内置。

---

## 技术栈

Node.js + TypeScript（ESM）、Express 5、ws、opencode CLI、纯静态前端（GitHub Pages）。

## License

MIT
