/**
 * 主服务器：Express HTTP API + WebSocket 实时推送
 * Phase 2：集成 opencode 角色调度 + 状态显示
 */
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  initStore, createGroup, listGroups, getGroup, saveGroup,
  appendMessage, listMessages, getAnnouncement, saveAnnouncement,
  listAgents, getAgent
} from './store.js';
import type { Message } from './types.js';
import { triggerAgents, setStatusCallback, getGroupStates, type AgentState } from './agent-runner.js';
import { checkOpencode } from './opencode.js';

const PORT = parseInt(process.env.AGC_PORT || '8787', 10);

const app = express();
app.use(express.json());

// ── CORS：允许 GitHub Pages 等外部前端连本地后端 ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// 静态前端页面（本地用）
app.use(express.static(join(process.cwd(), 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// WebSocket 连接池：按群分组
const clients = new Map<string, Set<WebSocket>>(); // groupName -> sockets

function broadcast(group: string, type: string, data: unknown) {
  const set = clients.get(group);
  if (!set) return;
  const payload = JSON.stringify({ type, group, data });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ── 注入状态回调：角色状态变化时广播给前端 ──
setStatusCallback((groupName, states) => {
  const obj: Record<string, AgentState> = {};
  for (const [k, v] of states) obj[k] = v;
  broadcast(groupName, 'agent_status', obj);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const group = url.searchParams.get('group');
  if (group) {
    if (!clients.has(group)) clients.set(group, new Set());
    clients.get(group)!.add(ws);
    // 连上后立刻推当前状态
    ws.send(JSON.stringify({
      type: 'agent_status',
      group,
      data: getGroupStates(group)
    }));
  }

  ws.on('close', () => {
    for (const set of clients.values()) set.delete(ws);
  });
});

// ── API：群管理 ──

app.get('/api/groups', (_req, res) => {
  res.json(listGroups());
});

app.post('/api/groups', (req, res) => {
  const { name, projectDir } = req.body;
  if (!name || !projectDir) {
    return res.status(400).json({ error: '需要 name 和 projectDir' });
  }
  try {
    const group = createGroup(name, projectDir);
    res.json(group);
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/groups/:name', (req, res) => {
  const group = getGroup(req.params.name);
  if (!group) return res.status(404).json({ error: '群不存在' });
  res.json(group);
});

// ── API：消息 ──

app.get('/api/groups/:name/messages', (req, res) => {
  const limit = parseInt(req.query.limit as string || '200', 10);
  res.json(listMessages(req.params.name, limit));
});

app.post('/api/groups/:name/messages', (req, res) => {
  const { text, from } = req.body;
  if (!text) return res.status(400).json({ error: '需要 text' });

  const msg: Message = {
    id: randomUUID(),
    from: from || 'user',
    fromType: 'user',
    text,
    at: new Date().toISOString(),
    mentions: parseMentions(text),
  };

  appendMessage(req.params.name, msg);
  broadcast(req.params.name, 'message', msg);
  res.json(msg);

  // 异步触发角色回复（不阻塞 HTTP 响应）
  const groupName = req.params.name;
  triggerAgents(groupName, msg, (agentId, replyText) => {
    const agent = getAgent(agentId);
    const replyMsg: Message = {
      id: randomUUID(),
      from: agent?.name || agentId,
      fromType: 'agent',
      text: replyText,
      at: new Date().toISOString(),
      mentions: [],
    };
    appendMessage(groupName, replyMsg);
    broadcast(groupName, 'message', replyMsg);
  });
});

// ── API：群公告 ──

app.get('/api/groups/:name/announcement', (req, res) => {
  res.json({ content: getAnnouncement(req.params.name) });
});

app.put('/api/groups/:name/announcement', (req, res) => {
  saveAnnouncement(req.params.name, req.body.content || '');
  res.json({ ok: true });
});

// ── API：成员管理 ──

app.get('/api/groups/:name/members', (req, res) => {
  const group = getGroup(req.params.name);
  if (!group) return res.status(404).json({ error: '群不存在' });
  res.json(group.members);
});

app.post('/api/groups/:name/members', (req, res) => {
  const group = getGroup(req.params.name);
  if (!group) return res.status(404).json({ error: '群不存在' });
  const { agentId } = req.body;
  if (!group.members.includes(agentId)) {
    group.members.push(agentId);
    saveGroup(group);
  }
  res.json(group.members);
});

app.delete('/api/groups/:name/members/:agentId', (req, res) => {
  const group = getGroup(req.params.name);
  if (!group) return res.status(404).json({ error: '群不存在' });
  group.members = group.members.filter(m => m !== req.params.agentId);
  saveGroup(group);
  res.json(group.members);
});

// ── API：角色库 ──

app.get('/api/roles', (_req, res) => {
  res.json(listAgents());
});

// ── API：角色状态 ──

app.get('/api/groups/:name/agent-status', (req, res) => {
  res.json(getGroupStates(req.params.name));
});

// ── API：opencode 健康检查 ──

app.get('/api/health/opencode', async (_req, res) => {
  const result = await checkOpencode();
  res.json(result);
});

// ── 工具函数：解析消息里的 @角色 ──

function parseMentions(text: string): string[] {
  const matches = text.match(/@([a-z0-9-]+)/gi);
  if (!matches) return [];
  return matches.map(m => m.slice(1).toLowerCase());
}

// ── 启动 ──

initStore();

// 启动时检查 opencode
checkOpencode().then(result => {
  if (result.ok) {
    console.log(`  opencode 检测到：${result.version}`);
  } else {
    console.log(`  ⚠️ opencode 未安装，请先运行：npm install -g opencode-ai && opencode auth login`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Agent Group Chat 服务器已启动`);
  console.log(`  http://localhost:${PORT}\n`);
});
