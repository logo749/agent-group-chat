/**
 * 本地文件存储层
 * 数据根目录 ~/.agc/，所有数据都是本地文件，不用数据库
 * 角色加载：项目内置 roles/（跟着 git 走） + 用户自定义 ~/.agc/roles/
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

// 项目内置角色目录（跟代码一起走）
const BUILTIN_ROLES_DIR = resolve(process.cwd(), 'roles');

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

  const resolvedProjectDir = resolve(projectDir);

  // 自动创建项目目录（opencode --dir 要求目录必须存在）
  ensureDir(resolvedProjectDir);

  ensureDir(dir);
  ensureDir(join(dir, 'contexts'));

  const config: GroupConfig = {
    name,
    projectDir: resolvedProjectDir,
    members: [],
    createdAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, 'group.json'), JSON.stringify(config, null, 2));
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

// ── 角色库（合并内置 + 用户自定义）──

export function getUserRolesDir(): string {
  return join(DATA_DIR, 'roles');
}

export function listAgents(): AgentDefinition[] {
  const result: AgentDefinition[] = [];
  const seen = new Set<string>();

  loadAgentsFromDir(BUILTIN_ROLES_DIR, result, seen, false);
  loadAgentsFromDir(getUserRolesDir(), result, seen, true);

  return result;
}

function loadAgentsFromDir(
  dir: string,
  out: AgentDefinition[],
  seen: Set<string>,
  override: boolean
) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.replace(/\.md$/, '');
    if (seen.has(id) && !override) continue;
    try {
      const content = readFileSync(join(dir, f), 'utf-8');
      const agent = parseAgentFile(content, id);
      if (seen.has(id)) {
        const idx = out.findIndex(a => a.id === id);
        if (idx >= 0) out[idx] = agent;
      } else {
        out.push(agent);
        seen.add(id);
      }
    } catch { /* 跳过坏文件 */ }
  }
}

export function getAgent(id: string): AgentDefinition | null {
  const userPath = join(getUserRolesDir(), `${id}.md`);
  if (existsSync(userPath)) {
    return parseAgentFile(readFileSync(userPath, 'utf-8'), id);
  }
  const builtinPath = join(BUILTIN_ROLES_DIR, `${id}.md`);
  if (existsSync(builtinPath)) {
    return parseAgentFile(readFileSync(builtinPath, 'utf-8'), id);
  }
  return null;
}

function parseAgentFile(content: string, id: string): AgentDefinition {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) {
    return { id, name: id, description: '', emoji: '🤖', systemPrompt: content.trim() };
  }

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

export { DATA_DIR, BUILTIN_ROLES_DIR, ensureDir };
