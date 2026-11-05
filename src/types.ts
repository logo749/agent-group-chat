/** 全局类型定义 */

export interface Message {
  id: string;
  from: string;
  fromType: 'user' | 'agent' | 'system';
  text: string;
  at: string;           // ISO 时间
  mentions?: string[];  // @了哪些角色
  replyTo?: string;     // 回复哪条消息
}

export interface GroupConfig {
  name: string;
  projectDir: string;       // 项目文件夹路径（opencode 干活的地方）
  members: string[];        // 成员角色 id 列表
  createdAt: string;
}

export interface AgentDefinition {
  id: string;              // 角色 id，如 "product-manager"
  name: string;             // 显示名，如 "产品经理"
  description: string;
  emoji: string;
  systemPrompt: string;     // 正文（frontmatter 之后的内容）
}

export interface WSMessage {
  type: 'message' | 'group_created' | 'group_updated';
  group: string;
  data: unknown;
}
