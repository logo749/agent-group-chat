/** 全局类型定义 */

export interface Message {
  id: string;
  from: string;
  fromType: 'user' | 'agent' | 'system';
  text: string;
  at: string;
  mentions?: string[];
  replyTo?: string;
}

export interface GroupConfig {
  id: string;
  name: string;
  projectDir: string;
  members: string[];
  createdAt: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  emoji: string;
  systemPrompt: string;
  builtin?: boolean; // 是否内置角色（内置的不能删，只能复制？或者也能删？）
}

export type WSMessageType =
  | 'message'
  | 'agent_status'
  | 'group_created'
  | 'group_updated'
  | 'group_deleted';

export interface WSMessage {
  type: WSMessageType;
  group: string;
  data: unknown;
}
