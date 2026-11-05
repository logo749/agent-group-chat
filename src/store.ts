/**
 * 本地文件存储层
 * 数据根目录 ~/.agc/，所有数据都是本地文件，不用数据库
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync
} from 'node:fs';
import type { Message, GroupConfig, AgentDefinition } from './types.js';

const DATA_DIR = process.env.AGC_DATA_DIR
  ? resolve(process.env.AGC_DATA_DIR)
  : join(homedir(), '.agc');

// ── 初始化数据目录 ──
function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function initStore() {
  ensureDir(DATA_DIR);
  ensureDir(join(DATA_DIR, 'groups'));
  ensureDir(join(DATA_DIR, 'roles'));
}

// ── 群管理 ──

export function getGroupDir(groupName: string): string {
  return join(DATA_DIR, 'groups', groupName);
}

export function createGroup(name: string, projectDir: string): GroupConfig {
  const dir = getGroupDir(name);
  if (existsSync(dir)) throw new Error(`群已存在: ${name}`);

  ensureDir(dir);
  ensureDir(join(dir, 'contexts'));

  const config: GroupConfig = {
    name,
    projectDir: resolve(projectDir),
    members: [],
    createdAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, 'group.json'), JSON.stringify(config, null, 2));
  // 默认空公告
  writeFileSync(join(dir, 'announcement.md'), '# 群公告\n\n在这里写协作规则...\n');

  return config;
}

export function listGroups(): GroupConfig[] {
  const groupsDir = join(DATA_DIR, 'groups');
  if (!existsSync(groupsDir)) return [];

  const result: GroupConfig[] = [];
  for (const entry of readdirSync(groupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = join(groupsDir, entry.name, 'group.json');
    if (existsSync(configPath)) {
      try {
        result.push(JSON.parse(readFileSync(configPath, 'utf-8')));
      } catch { /* 跳过坏文件 */ }
    }
  }
  return result;
}

export function getGroup(name: string): GroupConfig | null {
  const configPath = join(getGroupDir(name), 'group.json');
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

export function saveGroup(config: GroupConfig) {
  const dir = getGroupDir(config.name);
  ensureDir(dir);
  writeFileSync(join(dir, 'group.json'), JSON.stringify(config, null, 2));
}

// ── 消息存储（JSONL 追加写）──

export function getMessagesPath(groupName: string): string {
  return join(getGroupDir(groupName), 'messages.jsonl');
}

export function appendMessage(groupName: string, msg: Message) {
  const path = getMessagesPath(groupName);
  appendFileSync(path, JSON.stringify(msg) + '\n');
}

export function listMessages(groupName: string, limit = 200): Message[] {
  const path = getMessagesPath(groupName);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  const msgs = lines.slice(-limit).map(l => JSON.parse(l) as Message);
  return msgs;
}

// ── 群公告 ──

export function getAnnouncement(groupName: string): string {
  const path = join(getGroupDir(groupName), 'announcement.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function saveAnnouncement(groupName: string, content: string) {
  const path = join(getGroupDir(groupName), 'announcement.md');
  writeFileSync(path, content);
}

// ── 角色库 ──

export function getRolesDir(): string {
  return join(DATA_DIR, 'roles');
}

export function listAgents(): AgentDefinition[] {
  const dir = getRolesDir();
  if (!existsSync(dir)) return [];

  const result: AgentDefinition[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const content = readFileSync(join(dir, f), 'utf-8');
      result.push(parseAgentFile(content, f.replace(/\.md$/, '')));
    } catch { /* 跳过 */ }
  }
  return result;
}

export function getAgent(id: string): AgentDefinition | null {
  const path = join(getRolesDir(), `${id}.md`);
  if (!existsSync(path)) return null;
  return parseAgentFile(readFileSync(path, 'utf-8'), id);
}

/**
 * 解析角色 .md 文件
 * 格式：frontmatter（--- 包裹）+ 正文（system prompt）
 * 参考 agency-orchestrator/src/agents/loader.ts 的 parseAgentFile
 */
function parseAgentFile(content: string, id: string): AgentDefinition {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) {
    return { id, name: id, description: '', emoji: '🤖', systemPrompt: content.trim() };
  }

  // 简单解析 frontmatter（不用 js-yaml，结构简单）
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      meta[key] = value;
    }
  }

  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    emoji: meta.emoji || '🤖',
    systemPrompt: m[2].trim(),
  };
}

export { DATA_DIR };
