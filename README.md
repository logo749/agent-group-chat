# Agent Group Chat

> 多角色 AI 群聊协作平台 — 你当群主，多个 AI 角色当你的团队，基于 opencode 在项目文件夹里干活。

[设计文档](./DESIGN.md)

---

## 这是什么

想象一个微信群，群成员不是人，是几个 AI 专家（产品经理、架构师、设计师…）。你在群里发一句话，
他们按分工协作回复，直接在你的项目文件夹里读写文件、跑命令。

- **一个群 = 一个项目文件夹**
- **角色 = AI 专家**（.md 文件定义，system prompt）
- **群公告 = 协作规则**
- **底层 = opencode CLI**（你本地已装）

---

## 快速开始

### 前置条件
- Node.js >= 20
- 本地已安装 opencode 并完成登录（`opencode auth login`）

### 安装并启动

```bash
# 克隆
git clone https://github.com/logo749/agent-group-chat.git
cd agent-group-chat

# 安装依赖
npm install

# 开发模式（自动重启）
npm run dev

# 或者编译后运行
npm run build && npm start
```

启动后打开浏览器访问 `http://localhost:8787`。

### 第一次使用

1. 打开页面 → 输入后端地址（默认 `http://localhost:8787`）→ 连接
2. 左侧点「+ 新建群」→ 输入群名和项目文件夹路径
3. 右侧角色库点「+」把角色加进群
4. 在输入框发消息，看角色回复

---

## 项目结构

```
agent-group-chat/
├── src/
│   ├── server.ts       # 主服务器（Express + WebSocket）
│   ├── store.ts         # 本地文件存储（JSONL）
│   └── types.ts         # 类型定义
├── public/
│   └── index.html       # 前端聊天界面
├── roles/               # 角色定义（.md 文件）
│   ├── product-manager.md
│   └── software-architect.md
└── ~/.agc/              # 运行时数据（自动创建）
    ├── roles/            # 你的自定义角色
    └── groups/           # 你的群和消息记录
```

---

## 当前进度

- [x] **Phase 1**：基础框架（本地能发消息看消息）
- [ ] Phase 2：角色系统 + opencode 连接器
- [ ] Phase 3：消息路由（@ + 自主判断）
- [ ] Phase 4：前端美化 + 群管理界面
- [ ] Phase 5：部署到 GitHub Pages

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGC_PORT` | `8787` | 后端端口 |
| `AGC_DATA_DIR` | `~/.agc` | 数据存储目录 |
