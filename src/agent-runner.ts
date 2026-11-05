/**
 * 角色调度器
 * 用户发消息后，决定哪些角色要回复：
 * 1. @指定的角色 → 直接回复
 * 2. 其他角色 → 自主判断是否相关（简单关键词匹配）
 * 同时管理角色状态，通过回调广播给前端
 */
import { runOpencode } from './opencode.js';
import { getGroup, getAgent, ensureDir } from './store.js';
import type { Message, AgentDefinition } from './types.js';

export type AgentStatus = 'idle' | 'thinking' | 'replying' | 'done' | 'error';

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  startedAt?: string;
  finishedAt?: string;
}

const groupStates = new Map<string, Map<string, AgentState>>();

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

// ── 日志工具 ──
function log(...args: any[]) {
  console.log('[调度]', ...args);
}
function logError(...args: any[]) {
  console.error('[调度错误]', ...args);
}

/**
 * 触发角色回复流程
 */
export async function triggerAgents(
  groupName: string,
  userMsg: Message,
  onAgentReply: (agentId: string, text: string) => void
) {
  const group = getGroup(groupName);
  if (!group) {
    log(`群 ${groupName} 不存在，跳过`);
    return;
  }

  ensureDir(group.projectDir);

  const members = group.members;
  log(`收到消息，群=${groupName}，成员=${members.length}个，项目目录=${group.projectDir}`);
  log(`消息内容: "${userMsg.text.slice(0, 80)}${userMsg.text.length > 80 ? '...' : ''}"`);

  if (members.length === 0) {
    log('群里没有成员，从右侧角色库添加几个角色试试');
    return;
  }

  // 1. 找出 @指定的角色
  const mentioned = (userMsg.mentions || []).filter(m => members.includes(m));
  log(`@的角色: ${mentioned.length ? mentioned.join(', ') : '无'}`);

  // 2. 判断哪些角色要回复
  const toReply: { agent: AgentDefinition; reason: 'mention' | 'related' }[] = [];

  for (const agentId of mentioned) {
    const agent = getAgent(agentId);
    if (agent) {
      toReply.push({ agent, reason: 'mention' });
      log(`  → ${agent.name} 被 @ 触发`);
    }
  }

  // 其他角色：关键词匹配判断是否相关
  if (mentioned.length === 0) {
    log('没有 @任何人，尝试关键词匹配...');
    for (const agentId of members) {
      if (mentioned.includes(agentId)) continue;
      const agent = getAgent(agentId);
      if (!agent) continue;
      if (isRelevant(userMsg.text, agent)) {
        toReply.push({ agent, reason: 'related' });
        log(`  → ${agent.name} 关键词匹配触发`);
      }
    }
  }

  if (toReply.length === 0) {
    log('没有触发任何角色。提示：用 @角色名 可以直接指定，或者消息里提到角色相关关键词');
    return;
  }

  log(`共 ${toReply.length} 个角色要回复，开始串行调用 opencode...`);

  // 3. 逐个跑 opencode（串行）
  for (const { agent, reason } of toReply) {
    try {
      log(`▶ 开始调用 ${agent.name}（${agent.id}），原因=${reason}`);
      updateStatus(groupName, agent.id, 'thinking', { startedAt: new Date().toISOString() });

      const contextPrefix = reason === 'related'
        ? `[群消息，你判断与自己相关，请基于你的角色简要回应]\n`
        : '';
      
      const fullUserMsg = contextPrefix + userMsg.text;

      const result = await runOpencode(
        agent.systemPrompt,
        fullUserMsg,
        group.projectDir
      );

      log(`◀ ${agent.name} 返回，耗时 ${result.durationMs}ms，输出长度=${result.text?.length || 0}`);

      if (result.error) {
        logError(`${agent.name} 调用失败: ${result.error}`);
        updateStatus(groupName, agent.id, 'error', { finishedAt: new Date().toISOString() });
        onAgentReply(agent.id, `⚠️ opencode 调用失败：${result.error}`);
      } else if (result.text) {
        updateStatus(groupName, agent.id, 'replying');
        onAgentReply(agent.id, result.text);
        updateStatus(groupName, agent.id, 'done', { finishedAt: new Date().toISOString() });
        log(`✓ ${agent.name} 回复成功`);
      } else {
        logError(`${agent.name} 返回空内容`);
        updateStatus(groupName, agent.id, 'done', { finishedAt: new Date().toISOString() });
      }
    } catch (e: any) {
      logError(`${agent.name} 出错:`, e.message);
      updateStatus(groupName, agent.id, 'error', { finishedAt: new Date().toISOString() });
      onAgentReply(agent.id, `⚠️ 角色 ${agent.name} 出错：${e.message}`);
    }
  }

  log(`全部角色调用完成`);
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
