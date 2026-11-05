/**
 * 角色调度器
 * 1. @指定的角色 → 直接回复
 * 2. 其他角色 → 关键词匹配自主判断是否相关
 * 3. 每个角色独立上下文，注入群公告 + 历史消息
 * 4. 状态管理，通过回调广播给前端
 */
import { runOpencode } from './opencode.js';
import { getGroup, getAgent, getAnnouncement, listMessages, ensureDir } from './store.js';
import type { Message, AgentDefinition } from './types.js';

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

  // 1. @指定的角色
  const mentioned = (userMsg.mentions || []).filter(m => members.includes(m));
  log(`@的角色: ${mentioned.length ? mentioned.join(', ') : '无'}`);

  // 2. 决定哪些角色回复
  const toReply: { agent: AgentDefinition; reason: 'mention' | 'related' }[] = [];

  for (const agentId of mentioned) {
    const agent = getAgent(agentId);
    if (agent) {
      toReply.push({ agent, reason: 'mention' });
      log(`  → ${agent.name} 被 @ 触发`);
    }
  }

  // 没 @ 时，所有成员做关键词相关性判断
  if (mentioned.length === 0) {
    log('没有 @任何人，关键词匹配中...');
    for (const agentId of members) {
      const agent = getAgent(agentId);
      if (!agent) continue;
      if (isRelevant(userMsg.text, agent)) {
        toReply.push({ agent, reason: 'related' });
        log(`  → ${agent.name} 关键词匹配触发`);
      }
    }
  }

  if (toReply.length === 0) {
    log('没有触发任何角色。用 @角色名 可以直接指定');
    return;
  }

  // 准备公共上下文
  const announcement = getAnnouncement(groupId);
  const history = listMessages(groupId, 50).slice(0, -1); // 不含当前这条

  log(`共 ${toReply.length} 个角色要回复，开始串行调用...`);

  // 3. 逐个调用 opencode
  for (const { agent, reason } of toReply) {
    try {
      log(`▶ 开始调用 ${agent.name}（${agent.id}），原因=${reason}`);
      updateStatus(groupId, agent.id, 'thinking', { startedAt: new Date().toISOString() });

      // 构造完整 system prompt：角色设定 + 群公告 + 历史上下文
      const systemPrompt = buildSystemPrompt(agent, announcement, history);

      const userPrompt = reason === 'related'
        ? `[群消息，你判断与自己相关，请基于你的角色简要回应]\n${userMsg.text}`
        : userMsg.text;

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

/** 构造完整 system prompt：角色 + 公告 + 历史 */
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
