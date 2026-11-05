/**
 * 角色调度器
 * 1. @指定的角色 → 直接回复
 * 2. 没 @ 时 → 先让 LLM 当调度员，自主判断该哪些角色回复（输出 JSON）
 * 3. LLM 路由失败 → 回退到关键词匹配
 * 4. 每个角色独立上下文，注入群公告 + 历史消息
 * 5. 状态管理，通过回调广播给前端
 */
import { runOpencode } from './opencode.js';
import { getGroup, getAgent, getAnnouncement, listMessages, ensureDir } from './store.js';
import type { Message, GroupConfig, AgentDefinition } from './types.js';

export type AgentStatus = 'idle' | 'thinking' | 'replying' | 'done' | 'error';

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const groupStates = new Map<string, Map<string, AgentState>>();

let onStatusChange: ((groupId: string, states: Record<string, AgentState>) => void) | null = null;

export function setStatusCallback(cb: (groupId: string, states: Record<string, AgentState>) => void) {
  onStatusChange = cb;
}

function getGroupState(groupId: string): Map<string, AgentState> {
  if (!groupStates.has(groupId)) groupStates.set(groupId, new Map());
  return groupStates.get(groupId)!;
}

function updateStatus(groupId: string, agentId: string, status: AgentStatus, extra?: Partial<AgentState>) {
  const states = getGroupState(groupId);
  const existing = states.get(agentId) || { agentId, status: 'idle' as AgentStatus };
  states.set(agentId, { ...existing, agentId, status, ...extra });

  const obj: Record<string, AgentState> = {};
  for (const [k, v] of states) obj[k] = v;
  onStatusChange?.(groupId, obj);
}

export function getGroupStates(groupId: string): Record<string, AgentState> {
  const states = getGroupState(groupId);
  const result: Record<string, AgentState> = {};
  for (const [k, v] of states) result[k] = v;
  return result;
}

function log(...args: any[]) { console.log('[调度]', ...args); }
function logError(...args: any[]) { console.error('[调度错误]', ...args); }

/**
 * 触发角色回复流程
 */
export async function triggerAgents(
  groupId: string,
  userMsg: Message,
  onAgentReply: (agentId: string, text: string) => void
) {
  const group = getGroup(groupId);
  if (!group) { log(`群 ${groupId} 不存在`); return; }

  ensureDir(group.projectDir);

  const members = group.members;
  log(`收到消息，群=${group.name}，成员=${members.length}个，目录=${group.projectDir}`);
  log(`消息: "${userMsg.text.slice(0, 80)}${userMsg.text.length > 80 ? '...' : ''}"`);

  if (members.length === 0) {
    log('群里没有成员，从右侧角色库添加');
    return;
  }

  // 1. 决定要回复的角色 id 列表
  let replyIds: string[];
  let reason: 'mention' | 'routed' | 'keyword';

  const mentioned = (userMsg.mentions || []).filter(m => members.includes(m));
  log(`@的角色: ${mentioned.length ? mentioned.join(', ') : '无'}`);

  if (mentioned.length > 0) {
    replyIds = mentioned;
    reason = 'mention';
  } else {
    // 没 @：让 LLM 自主判断该谁回复
    log('没有 @任何人，交给 LLM 调度员自主判断...');
    replyIds = await routeMessage(group, userMsg);
    reason = 'routed';

    // 路由返回空（LLM 认为都不相关），不再回退，直接结束
    if (replyIds.length === 0) {
      log('LLM 判断当前没有角色需要回复此消息。用 @角色名 可强制指定');
      return;
    }
  }

  const toReply: { agent: AgentDefinition; reason: 'mention' | 'routed' | 'keyword' }[] = [];
  for (const id of replyIds) {
    const agent = getAgent(id);
    if (agent) {
      toReply.push({ agent, reason });
      log(`  → ${agent.name}（${id}）将回复，触发方式=${reason}`);
    }
  }

  if (toReply.length === 0) {
    log('没有可回复的有效角色');
    return;
  }

  // 公共上下文
  const announcement = getAnnouncement(groupId);
  const history = listMessages(groupId, 50).slice(0, -1);

  log(`共 ${toReply.length} 个角色要回复，开始串行调用...`);

  // 2. 逐个调用 opencode
  for (const { agent, reason: r } of toReply) {
    try {
      log(`▶ 开始调用 ${agent.name}（${agent.id}）`);
      updateStatus(groupId, agent.id, 'thinking', { startedAt: new Date().toISOString() });

      const systemPrompt = buildSystemPrompt(agent, announcement, history);

      const userPrompt = r === 'mention'
        ? userMsg.text
        : `[群消息，调度判断与你相关，请基于你的角色回应]\n${userMsg.text}`;

      const result = await runOpencode(systemPrompt, userPrompt, group.projectDir);

      log(`◀ ${agent.name} 返回，耗时 ${result.durationMs}ms，长度=${result.text?.length || 0}`);

      if (result.error) {
        logError(`${agent.name} 失败: ${result.error}`);
        updateStatus(groupId, agent.id, 'error', {
          finishedAt: new Date().toISOString(),
          error: result.error,
        });
        onAgentReply(agent.id, `⚠️ opencode 调用失败：${result.error}`);
      } else if (result.text) {
        updateStatus(groupId, agent.id, 'replying');
        onAgentReply(agent.id, result.text);
        updateStatus(groupId, agent.id, 'done', { finishedAt: new Date().toISOString() });
        log(`✓ ${agent.name} 回复成功`);
      } else {
        logError(`${agent.name} 返回空内容`);
        updateStatus(groupId, agent.id, 'done', { finishedAt: new Date().toISOString() });
      }
    } catch (e: any) {
      logError(`${agent.name} 出错:`, e.message);
      updateStatus(groupId, agent.id, 'error', { finishedAt: new Date().toISOString(), error: e.message });
      onAgentReply(agent.id, `⚠️ 角色 ${agent.name} 出错：${e.message}`);
    }
  }

  log(`全部角色调用完成`);
}

// ────────────────────────────────────────────
// LLM 路由：让模型自主判断该哪些角色回复
// ────────────────────────────────────────────

async function routeMessage(group: GroupConfig, userMsg: Message): Promise<string[]> {
  const memberText = group.members
    .map(id => { const role = getAgent(id); return role ? { id, role } : null; })
    .filter(Boolean)
    .map(({ id, role }: any) =>
      `- id="${id}" ${role.emoji}${role.name}：${role.description || role.systemPrompt.slice(0, 60)}`
    )
    .join('\n');

  const routerSystem = '你是群聊调度员。你只能输出 JSON，不输出任何解释、markdown 代码块或多余文字。';

  const routerUser = `请判断下面这条群消息应该由哪些成员负责回复。依据每个成员的职责判断，可多选也可只选一个；确实都不相关时返回空数组。

成员列表：
${memberText}

群消息：${userMsg.text}

只输出以下格式（agents 里的 id 必须来自上面的成员列表）：
{"agents": ["成员id"]}`;

  const result = await runOpencode(routerSystem, routerUser, group.projectDir);

  if (result.error || !result.text) {
    logError(`LLM 路由调用失败：${result.error || '空输出'}，回退关键词匹配`);
    return keywordFallback(group, userMsg.text);
  }

  try {
    const jsonStr = extractJsonObject(result.text);
    const parsed = JSON.parse(jsonStr);
    let ids: string[] = Array.isArray(parsed.agents) ? parsed.agents.map((x: any) => String(x).trim()) : [];
    ids = [...new Set(ids.filter(id => group.members.includes(id)))];
    log(`LLM 路由结果：${ids.length ? ids.join(', ') : '空（无需回复）'}`);
    return ids;
  } catch (e: any) {
    logError(`LLM 路由 JSON 解析失败：${e.message}，原始输出前200字：${result.text.slice(0, 200)}，回退关键词`);
    return keywordFallback(group, userMsg.text);
  }
}

/** 从可能含代码块/解释的文本里提取第一个完整 JSON 对象 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error('未找到 JSON 对象');
}

/** 路由失败时的兜底：关键词匹配 */
function keywordFallback(group: GroupConfig, text: string): string[] {
  const ids = group.members.filter(id => {
    const role = getAgent(id);
    return role ? isRelevant(text, role) : false;
  });
  log(`关键词兜底结果：${ids.length ? ids.join(', ') : '空'}`);
  return ids;
}

// ────────────────────────────────────────────
// system prompt 构造
// ────────────────────────────────────────────

function buildSystemPrompt(agent: AgentDefinition, announcement: string, history: Message[]): string {
  const parts: string[] = [];

  parts.push(`# 你的角色\n${agent.systemPrompt}`);

  if (announcement && announcement.trim()) {
    parts.push(`# 群公告 / 工作流规则\n${announcement.trim()}`);
  }

  if (history.length) {
    const historyText = history
      .filter(m => m.fromType !== 'system')
      .slice(-20)
      .map(m => {
        const prefix = m.fromType === 'user' ? '用户' : m.from;
        return `${prefix}：${m.text}`;
      })
      .join('\n');
    if (historyText) parts.push(`# 群聊历史（请记住这些上下文）\n${historyText}`);
  }

  parts.push('请基于以上角色设定和上下文，直接输出你的回复，不要复述规则。');

  return parts.join('\n\n---\n\n');
}

function isRelevant(text: string, agent: AgentDefinition): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(agent.name.toLowerCase())) return true;
  if (agent.emoji && text.includes(agent.emoji)) return true;
  if (agent.description) {
    const keywords = agent.description.split(/[\s,，、；;]+/).filter(w => w.length >= 2);
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}
