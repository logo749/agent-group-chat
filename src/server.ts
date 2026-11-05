/**
 * 主服务器：Express HTTP API + WebSocket 实时推送
 */
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  initStore, createGroup, listGroups, getGroup, saveGroup,
  updateGroup, deleteGroup,
  appendMessage, listMessages, getAnnouncement, saveAnnouncement,
  listAgents, getAgent, saveAgent, deleteAgent
} from './store.js';
import type { Message, AgentDefinition } from './types.js';
import { checkOpencode } from './opencode.js';
import { triggerAgents, setStatusCallback, getGroupStates } from './agent-runner.js';

const PORT = parseInt(process.env.AGC_PORT || '8787', 10);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.use(express.static(join(process.cwd(), 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map<string, Set<WebSocket>>();

function broadcast(group: string, type: string, data: unknown) {
  const set = clients.get(group);
  if (!set) return;
  const payload = JSON.stringify({ type, group, data });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// 角色状态变化 → 广播
setStatusCallback((groupId, states) => {
  broadcast(groupId, 'agent_status', states);
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
      data: getGroupStates(group),
    }));
  }

  ws.on('close', () => {
    for (const set of clients.values()) set.delete(ws);
  });
});

// ────────────────────────────────────────────
// 健康检查
// ────────────────────────────────────────────

app.get('/api/health', async (_req, res) => {
  const opencodeResult = await checkOpencode();
  res.json({ ok: true, opencode: opencodeResult });
});

// ────────────────────────────────────────────
// 群管理
// ────────────────────────────────────────────

app.get('/api/groups', (_req, res) => {
  res.json(listGroups());
});

app.post('/api/groups', (req, res) => {
  const { name, projectDir } = req.body;
  if (!name || !projectDir) return res.status(400).json({ error: '需要 name 和 projectDir' });
  try {
    const group = createGroup(name, projectDir);
    res.json(group);
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/groups/:id', (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: '群不存在' });
  res.json(group);
});

app.patch('/api/groups/:id', (req, res) => {
  const updated = updateGroup(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: '群不存在' });
  broadcast(req.params.id, 'group_updated', updated);
  res.json(updated);
});

app.delete('/api/groups/:id', (req, res) => {
  const ok = deleteGroup(req.params.id);
  if (!ok) return res.status(404).json({ error: '群不存在' });
  broadcast(req.params.id, 'group_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ────────────────────────────────────────────
// 消息
// ────────────────────────────────────────────

app.get('/api/groups/:id/messages', (req, res) => {
  const limit = parseInt(req.query.limit as string || '200', 10);
  res.json(listMessages(req.params.id, limit));
});

app.post('/api/groups/:id/messages', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '需要 text' });

  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: '群不存在' });

  const msg: Message = {
    id: randomUUID(),
    from: '我',
    fromType: 'user',
    text,
    at: new Date().toISOString(),
    mentions: parseMentions(text),
  };

  appendMessage(req.params.id, msg);
  broadcast(req.params.id, 'message', msg);
  res.json(msg);

  // 异步触发角色回复
  triggerAgents(req.params.id, msg, (agentId, replyText) => {
    const agent = getAgent(agentId);
    const replyMsg: Message = {
      id: randomUUID(),
      from: agent?.name || agentId,
      fromType: 'agent',
      text: replyText,
      at: new Date().toISOString(),
    };
    appendMessage(req.params.id, replyMsg);
    broadcast(req.params.id, 'message', replyMsg);
  }).catch(err => {
    console.error('调度失败:', err.message);
  });
});

// ────────────────────────────────────────────
// 群公告
// ────────────────────────────────────────────

app.get('/api/groups/:id/announcement', (req, res) => {
  res.json({ content: getAnnouncement(req.params.id) });
});

app.put('/api/groups/:id/announcement', (req, res) => {
  saveAnnouncement(req.params.id, req.body.content || '');
  res.json({ ok: true });
});

// ────────────────────────────────────────────
// 成员管理
// ────────────────────────────────────────────

app.post('/api/groups/:id/members', (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: '群不存在' });

  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: '需要 agentId' });

  if (!group.members.includes(agentId)) {
    group.members.push(agentId);
    saveGroup(group);

    const agent = getAgent(agentId);
    const sysMsg: Message = {
      id: randomUUID(),
      from: '系统',
      fromType: 'system',
      text: `${agent?.name || agentId} 加入了群聊`,
      at: new Date().toISOString(),
    };
    appendMessage(req.params.id, sysMsg);
    broadcast(req.params.id, 'message', sysMsg);
  }

  res.json(group);
});

app.delete('/api/groups/:id/members/:agentId', (req, res) => {
  const group = getGroup(req.params.id);
  if (!group) return res.status(404).json({ error: '群不存在' });

  group.members = group.members.filter(m => m !== req.params.agentId);
  saveGroup(group);

  const agent = getAgent(req.params.agentId);
  const sysMsg: Message = {
    id: randomUUID(),
    from: '系统',
    fromType: 'system',
    text: `${agent?.name || req.params.agentId} 被移出群聊`,
    at: new Date().toISOString(),
  };
  appendMessage(req.params.id, sysMsg);
  broadcast(req.params.id, 'message', sysMsg);

  res.json(group);
});

// ────────────────────────────────────────────
// 角色管理
// ────────────────────────────────────────────

app.get('/api/agents', (_req, res) => {
  res.json(listAgents());
});

app.post('/api/agents', (req, res) => {
  const { name, emoji, description, systemPrompt } = req.body;
  if (!name || !systemPrompt) return res.status(400).json({ error: '需要 name 和 systemPrompt' });

  const id = (req.body.id || 'r' + Date.now()).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const agent: Omit<AgentDefinition, 'builtin'> = {
    id,
    name,
    emoji: emoji || '🤖',
    description: description || '',
    systemPrompt,
  };

  try {
    const saved = saveAgent(agent);
    res.json(saved);
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/agents/:id', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: '角色不存在' });
  res.json(agent);
});

app.patch('/api/agents/:id', (req, res) => {
  const existing = getAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });

  const updated: Omit<AgentDefinition, 'builtin'> = {
    id: existing.id,
    name: req.body.name ?? existing.name,
    emoji: req.body.emoji ?? existing.emoji,
    description: req.body.description ?? existing.description,
    systemPrompt: req.body.systemPrompt ?? existing.systemPrompt,
  };

  const saved = saveAgent(updated);
  res.json(saved);
});

app.delete('/api/agents/:id', (req, res) => {
  const existing = getAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });
  if (existing.builtin) return res.status(403).json({ error: '内置角色不能删除' });

  const ok = deleteAgent(req.params.id);
  if (!ok) return res.status(404).json({ error: '角色文件不存在' });
  res.json({ ok: true });
});

// ────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────

function parseMentions(text: string): string[] {
  const matches = text.match(/@([\u4e00-\u9fa5a-zA-Z0-9-]+)/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1));
}

// ────────────────────────────────────────────
// 启动
// ────────────────────────────────────────────

initStore();

checkOpencode().then(result => {
  if (result.ok) {
    console.log(`  opencode 检测到：${result.version}`);
  } else {
    console.log(`  ⚠️ opencode 未安装或不可用`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Agent Group Chat 服务器已启动`);
  console.log(`  http://localhost:${PORT}\n`);
});
