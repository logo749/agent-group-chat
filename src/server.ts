/**
 * 主服务器：Express HTTP API + WebSocket 实时推送
 * Phase 1：基础聊天功能（发消息、看消息、群管理）
 */
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  initStore, createGroup, listGroups, getGroup, saveGroup,
  appendMessage, listMessages, getAnnouncement, saveAnnouncement,
  listAgents
} from './store.js';
import type { Message } from './types.js';

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

// WebSocket 连接池：按群分组，新消息时推给该群的所有客户端
const clients = new Map<string, Set<WebSocket>>(); // groupName -> sockets

function broadcast(group: string, data: unknown) {
  const set = clients.get(group);
  if (!set) return;
  const payload = JSON.stringify({ type: 'message', group, data });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  // 从 URL query 解析要监听的群名：/ws?group=xxx
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const group = url.searchParams.get('group');
  if (group) {
    if (!clients.has(group)) clients.set(group, new Set());
    clients.get(group)!.add(ws);
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
  broadcast(req.params.name, msg);
  res.json(msg);
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

// ── 工具函数：解析消息里的 @角色 ──

function parseMentions(text: string): string[] {
  const matches = text.match(/@([a-z0-9-]+)/gi);
  if (!matches) return [];
  return matches.map(m => m.slice(1).toLowerCase());
}

// ── 启动 ──

initStore();

server.listen(PORT, () => {
  console.log(`\n  Agent Group Chat 服务器已启动`);
  console.log(`  http://localhost:${PORT}\n`);
});
