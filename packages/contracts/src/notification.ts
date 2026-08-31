/** 统一通知只保存密钥引用；真实密钥由服务端环境或密钥管理器解析。 */
export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationChannelKind = "smtp" | "lark" | "wecom" | "dingtalk" | "webhook";

export interface SmtpNotificationCredential {
  kind: "smtp";
  host: string;
  port: number;
  from: string;
  username?: string;
  password?: string;
  secure?: boolean;
}

export interface LarkNotificationCredential {
  kind: "lark";
  appId: string;
  appSecret: string;
  baseUrl?: string;
}

export interface WecomNotificationCredential {
  kind: "wecom";
  corpId: string;
  corpSecret: string;
  agentId: number;
  baseUrl?: string;
}

export interface DingtalkNotificationCredential {
  kind: "dingtalk";
  appKey: string;
  appSecret: string;
  agentId: number;
  baseUrl?: string;
}

export interface WebhookNotificationCredential {
  kind: "webhook";
  signingSecret: string;
}

export type NotificationCredential =
  | SmtpNotificationCredential
  | LarkNotificationCredential
  | WecomNotificationCredential
  | DingtalkNotificationCredential
  | WebhookNotificationCredential;

export interface NotificationRecipient {
  id: string;
  kind: "person" | "group" | "external";
  name: string;
  address?: string;
  /** 企业应用定向投递使用平台侧用户 ID；不保存任何访问凭据。 */
  platformUserId?: string;
  /** 飞书定向消息可选择 open_id、user_id 或 chat_id；默认 open_id。 */
  platformTargetType?: "open_id" | "user_id" | "chat_id";
  /** 企业应用可定向部门，群机器人不解析部门成员。 */
  platformDepartmentIds?: string[];
  memberIds?: string[];
  mention?: { all?: boolean; platformUserIds?: string[] };
}

export interface NotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  endpoint?: string;
  secretRef?: string;
  enabled: boolean;
  /** 机器人仅面向一个群端点；个人/部门定向留给企业应用适配器。 */
  deliveryMode?: "bot" | "application";
}

export interface NotificationTemplate {
  id: string;
  format: "text" | "markdown" | "card-lite";
  title: string;
  body: string;
}

export interface NotificationRule {
  id: string;
  eventType: string;
  severities: NotificationSeverity[];
  target?: { projectId?: string; sceneId?: string; objectId?: string };
  recipientIds: string[];
  channelIds: string[];
  templateId: string;
  quietHours?: { startHour: number; endHour: number; timezoneOffsetMinutes?: number };
  dedupeWindowSeconds?: number;
  maxDeliveriesPerHour?: number;
}

export interface NotificationEvent {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  occurredAt: string;
  target?: { projectId?: string; sceneId?: string; objectId?: string };
  data?: Record<string, string | number | boolean>;
}

export interface NotificationDeliveryAudit {
  id: string;
  eventId: string;
  ruleId?: string;
  channelId?: string;
  recipientId?: string;
  status: "delivered" | "suppressed" | "failed" | "skipped";
  reason?: string;
  attempts: number;
  createdAt: string;
}
