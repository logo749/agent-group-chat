/**
 * 本地文件存储层
 * 数据根目录 ~/.agc/，所有数据都是本地文件
 * 角色：内置（项目 roles/） + 用户自定义（~/.agc/roles/）
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync, rmSync
} from 'node:fs';
import type { Message, GroupConfig, AgentDefinition } from './types.js';

const DATA_DIR = process.env.AGC_DATA_DIR
  ? resolve(process.env.AGC_DATA_DIR)
  : join(homedir(), '.agc');

const BUILTIN_ROLES_DIR = resolve(process.cwd(), 'roles');

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function initStore() {
  ensureDir(DATA_DIR);
  ensureDir(join(DATA_DIR, 'groups'));
  ensureDir(join(DATA_DIR, 'roles'));
}

// ────────────────────────────────────────────
// 群管理
// ────────────────────────────────────────────

function getGroupDir(groupId: string): string {
  return join(DATA_DIR, 'groups', groupId);
}

export function createGroup(name: string, projectDir: string): GroupConfig {
  const id = 'g' + Date.now();
  const dir = getGroupDir(id);
  if (existsSync(dir)) throw new Error('群已存在');

  const resolvedDir = resolve(projectDir);
  ensureDir(resolvedDir);

  ensureDir(dir);

  const config: GroupConfig = {
    id,
    name,
    projectDir: resolvedDir,
    members: [],
    createdAt: new Date().toISOString(),
  };

  writeFileSync(join(dir, 'group.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, 'announcement.md'), '');

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
      } catch { /* 跳过 */ }
    }
  }
  return result;
}

export function getGroup(id: string): GroupConfig | null {
  const configPath = join(getGroupDir(id), 'group.json');
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

export function saveGroup(config: GroupConfig) {
  const dir = getGroupDir(config.id);
  ensureDir(dir);
  writeFileSync(join(dir, 'group.json'), JSON.stringify(config, null, 2));
}

export function updateGroup(id: string, updates: Partial<Pick<GroupConfig, 'name' | 'projectDir'>>): GroupConfig | null {
  const group = getGroup(id);
  if (!group) return null;

  if (updates.name) group.name = updates.name;
  if (updates.projectDir) {
    group.projectDir = resolve(updates.projectDir);
    ensureDir(group.projectDir);
  }

  saveGroup(group);
  return group;
}

export function deleteGroup(id: string): boolean {
  const dir = getGroupDir(id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// ────────────────────────────────────────────
// 消息存储（JSONL）
// ────────────────────────────────────────────

function getMessagesPath(groupId: string): string {
  return join(getGroupDir(groupId), 'messages.jsonl');
}

export function appendMessage(groupId: string, msg: Message) {
  const path = getMessagesPath(groupId);
  appendFileSync(path, JSON.stringify(msg) + '\n');
}

export function listMessages(groupId: string, limit = 200): Message[] {
  const path = getMessagesPath(groupId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => JSON.parse(l) as Message);
}

// ────────────────────────────────────────────
// 群公告
// ────────────────────────────────────────────

export function getAnnouncement(groupId: string): string {
  const path = join(getGroupDir(groupId), 'announcement.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function saveAnnouncement(groupId: string, content: string) {
  writeFileSync(join(getGroupDir(groupId), 'announcement.md'), content);
}

// ────────────────────────────────────────────
// 角色管理（内置 + 用户自定义）
// ────────────────────────────────────────────

function getUserRolesDir(): string {
  return join(DATA_DIR, 'roles');
}

/** 列出所有角色：内置 + 用户自定义，用户自定义同名覆盖 */
export function listAgents(): AgentDefinition[] {
  const result: AgentDefinition[] = [];
  const seen = new Map<string, number>();

  loadRolesFromDir(BUILTIN_ROLES_DIR, true, result, seen);
  loadRolesFromDir(getUserRolesDir(), false, result, seen);

  return result;
}

function loadRolesFromDir(
  dir: string,
  builtin: boolean,
  out: AgentDefinition[],
  seen: Map<string, number>
) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.replace(/\.md$/, '');
    try {
      const agent = parseAgentFile(readFileSync(join(dir, f), 'utf-8'), id);
      agent.builtin = builtin;
      if (seen.has(id)) {
        out[seen.get(id)!] = agent;
      } else {
        seen.set(id, out.length);
        out.push(agent);
      }
    } catch { /* 跳过 */ }
  }
}

export function getAgent(id: string): AgentDefinition | null {
  const userPath = join(getUserRolesDir(), `${id}.md`);
  if (existsSync(userPath)) {
    const agent = parseAgentFile(readFileSync(userPath, 'utf-8'), id);
    agent.builtin = false;
    return agent;
  }
  const builtinPath = join(BUILTIN_ROLES_DIR, `${id}.md`);
  if (existsSync(builtinPath)) {
    const agent = parseAgentFile(readFileSync(builtinPath, 'utf-8'), id);
    agent.builtin = true;
    return agent;
  }
  return null;
}

/** 新建/保存用户角色（写 .md 文件） */
export function saveAgent(agent: Omit<AgentDefinition, 'builtin'>): AgentDefinition {
  const dir = getUserRolesDir();
  ensureDir(dir);

  const content = serializeAgent(agent);
  writeFileSync(join(dir, `${agent.id}.md`), content);

  return { ...agent, builtin: false };
}

/** 删除用户角色（内置角色不能删） */
export function deleteAgent(id: string): boolean {
  const path = join(getUserRolesDir(), `${id}.md`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
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
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
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

function serializeAgent(agent: Omit<AgentDefinition, 'builtin'>): string {
  return `---
name: ${agent.name}
emoji: ${agent.emoji}
description: ${agent.description}
---

${agent.systemPrompt}`;
}

export { DATA_DIR, BUILTIN_ROLES_DIR, ensureDir };
