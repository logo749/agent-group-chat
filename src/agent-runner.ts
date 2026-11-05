/**
 * 角色调度器
 * 用户发消息后，决定哪些角色要回复：
 * 1. @指定的角色 → 直接回复
 * 2. 其他角色 → 自主判断是否相关（简单关键词匹配，后续可换成 LLM 判断）
 * 同时管理角色状态（思考中/回复中/完成），通过回调广播给前端
 */
import { runOpencode } from './opencode.js';
import { getGroup, getAgent } from './store.js';
import type { Message, AgentDefinition } from './types.js';

export type AgentStatus = 'idle' | 'thinking' | 'replying' | 'done' | 'error';

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  startedAt?: string;
  finishedAt?: string;
}

// 群 → 各角色的当前状态
const groupStates = new Map<string, Map<string, AgentState>>();

// 状态变化回调（由 server.ts 注入，负责 WebSocket 广播）
let onStatusChange: ((groupName: string, states: Map<string, AgentState>) => void) | null = null;

export function setStatusCallback(cb: (groupName: string, states: Map<string, AgentState>) => void) {
  onStatusChange = cb;
}

function getGroupState(groupName: string): Map<string, AgentState> {
  if (!groupStates.has(groupName)) {
    groupStates.set(groupName, new Map());
  }
  return groupStates.get(groupName)!;
}

function updateStatus(groupName: string, agentId: string, status: AgentStatus, extra?: Partial<AgentState>) {
  const states = getGroupState(groupName);
  const existing = states.get(agentId) || { agentId, status: 'idle' as AgentStatus };
  states.set(agentId, { ...existing, agentId, status, ...extra });
  onStatusChange?.(groupName, states);
}

export function getGroupStates(groupName: string): Record<string, AgentState> {
  const states = getGroupState(groupName);
  const result: Record<string, AgentState> = {};
  for (const [k, v] of states) result[k] = v;
  return result;
}

/**
 * 触发角色回复流程
 * @param groupName 群名
 * @param userMsg 用户消息
 * @param onAgentReply 角色回复回调（appendMessage + broadcast）
 */
export async function triggerAgents(
  groupName: string,
  userMsg: Message,
  onAgentReply: (agentId: string, text: string) => void
) {
  const group = getGroup(groupName);
  if (!group) return;

  const members = group.members;
  if (members.length === 0) return;

  // 1. 找出 @指定的角色
  const mentioned = (userMsg.mentions || []).filter(m => members.includes(m));

  // 2. 判断哪些角色要回复
  const toReply: { agent: AgentDefinition; reason: 'mention' | 'related' }[] = [];

  for (const agentId of mentioned) {
    const agent = getAgent(agentId);
    if (agent) toReply.push({ agent, reason: 'mention' });
  }

  // 其他角色：简单关键词匹配判断是否相关
  // （后续可以换成 LLM 判断，这里先用简单规则跑通）
  if (mentioned.length === 0) {
    // 没有 @任何人 → 让所有角色都判断一下？还是只让相关的？
    // 简化：没有 @ 时，让所有成员都判断一下是否相关
    // 但这样会同时跑很多 opencode，太贵了
    // 折中：只有消息里提到角色关键词时才触发
    for (const agentId of members) {
      if (mentioned.includes(agentId)) continue;
      const agent = getAgent(agentId);
      if (!agent) continue;
      if (isRelevant(userMsg.text, agent)) {
        toReply.push({ agent, reason: 'related' });
      }
    }
  }

  if (toReply.length === 0) return;

  // 3. 逐个跑 opencode（串行，避免并发太多）
  for (const { agent, reason } of toReply) {
    try {
      updateStatus(groupName, agent.id, 'thinking', { startedAt: new Date().toISOString() });

      // 构造给 opencode 的消息
      // 如果是 @ 指定的，直接回答
      // 如果是相关判断，加一句上下文
      const contextPrefix = reason === 'related'
        ? `[群消息，你判断与自己相关，请基于你的角色简要回应]\n`
        : '';
      
      const fullUserMsg = contextPrefix + userMsg.text;

      // 调用 opencode
      const result = await runOpencode(
        agent.systemPrompt,
        fullUserMsg,
        group.projectDir
      );

      if (result.error) {
        updateStatus(groupName, agent.id, 'error', { finishedAt: new Date().toISOString() });
        onAgentReply(agent.id, `⚠️ opencode 调用失败：${result.error}`);
      } else if (result.text) {
        updateStatus(groupName, agent.id, 'replying');
        onAgentReply(agent.id, result.text);
        updateStatus(groupName, agent.id, 'done', { finishedAt: new Date().toISOString() });
      } else {
        updateStatus(groupName, agent.id, 'done', { finishedAt: new Date().toISOString() });
      }
    } catch (e: any) {
      updateStatus(groupName, agent.id, 'error', { finishedAt: new Date().toISOString() });
      onAgentReply(agent.id, `⚠️ 角色 ${agent.name} 出错：${e.message}`);
    }
  }
}

/**
 * 简单的相关性判断：消息里包含角色关键词就认为相关
 * 关键词从角色的 description 里提取（简化版：直接匹配角色名/emoji）
 */
function isRelevant(text: string, agent: AgentDefinition): boolean {
  const lower = text.toLowerCase();
  // 匹配角色名（中英文都试）
  if (lower.includes(agent.name.toLowerCase())) return true;
  // 匹配 emoji
  if (agent.emoji && text.includes(agent.emoji)) return true;
  // 匹配 description 里的关键词（简单拆词）
  if (agent.description) {
    const keywords = agent.description.split(/[\s,，、；;]+/).filter(w => w.length >= 2);
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}
