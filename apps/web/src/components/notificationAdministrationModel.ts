import type {
  NotificationChannelKind as ContractNotificationChannelKind,
  NotificationCredential,
  NotificationDeliveryAudit,
  NotificationSeverity as ContractNotificationSeverity,
} from "@bim-studio/contracts";

/**
 * 读取快照只表达“已配置”；端点原文与凭据都不能进入全局页面状态。
 */
export type NotificationChannelKind = ContractNotificationChannelKind;
export type NotificationSeverity = ContractNotificationSeverity;
export type NotificationDeliveryStatus = NotificationDeliveryAudit["status"];

export interface NotificationChannelView {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  deliveryMode?: "bot" | "application";
  endpointConfigured: boolean;
  credentialConfigured: boolean;
  endpointHint?: string;
  lastTest?: { status: "passed" | "failed"; message: string; at: string };
}

/** SMTP/企业应用依赖服务端凭据；群机器人和通用 Webhook 只依赖投递地址。 */
export function notificationChannelReady(channel: NotificationChannelView): boolean {
  return channel.kind === "smtp" || channel.deliveryMode === "application"
    ? channel.credentialConfigured
    : channel.endpointConfigured;
}

/** 写入请求与读取快照分离，端点和密钥不会留在页面全局状态。 */
export interface NotificationChannelSaveRequest {
  channel: NotificationChannelView;
  create?: boolean;
  endpoint?: string;
  credential?: NotificationCredential;
}

export interface NotificationRecipientView {
  id: string;
  type: "person" | "group" | "external";
  name: string;
  addressHint: string;
  address?: string;
  platformUserId?: string;
  platformTargetType?: "open_id" | "user_id" | "chat_id";
  platformDepartmentIds?: string[];
  memberIds?: string[];
  memberCount?: number;
}

export interface NotificationRecipientSaveRequest {
  recipient: NotificationRecipientView;
  create?: boolean;
}

export interface NotificationRuleView {
  id: string;
  name: string;
  eventType: string;
  enabled: boolean;
  severity: NotificationSeverity;
  recipientIds: string[];
  channelIds: string[];
  templateId: string;
  templateName: string;
  targetNames: string[];
  target?: { projectId?: string; sceneId?: string; objectId?: string };
  quietHours?: { start: string; end: string; timezone: string };
}

export interface NotificationRuleSaveRequest {
  rule: NotificationRuleView;
  create?: boolean;
}

export interface NotificationTemplateView {
  id: string;
  title: string;
  format: "text" | "markdown" | "card-lite";
}

export interface NotificationDeliveryView {
  id: string;
  createdAt: string;
  channelName: string;
  recipientName: string;
  templateName: string;
  status: NotificationDeliveryStatus;
  failureReason?: string;
  retryable: boolean;
}

export interface NotificationAdministrationState {
  channels: readonly NotificationChannelView[];
  recipients: readonly NotificationRecipientView[];
  rules: readonly NotificationRuleView[];
  templates: readonly NotificationTemplateView[];
  deliveries: readonly NotificationDeliveryView[];
}

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannelKind, readonly [string, string]> = {
  smtp: ["邮箱", "Email"],
  lark: ["飞书", "Lark"],
  wecom: ["企业微信", "WeCom"],
  dingtalk: ["钉钉", "DingTalk"],
  webhook: ["Webhook", "Webhook"],
};

export const NOTIFICATION_SEVERITY_LABELS: Record<NotificationSeverity, readonly [string, string]> = {
  info: ["提示", "Info"],
  warning: ["警告", "Warning"],
  critical: ["严重", "Critical"],
};

export function notificationDeliverySummary(state: NotificationAdministrationState) {
  return state.deliveries.reduce(
    (summary, delivery) => ({ ...summary, [delivery.status]: summary[delivery.status] + 1 }),
    { delivered: 0, failed: 0, suppressed: 0, skipped: 0 },
  );
}

export function createNotificationDraft(state: NotificationAdministrationState): NotificationAdministrationState {
  return structuredClone(state);
}
