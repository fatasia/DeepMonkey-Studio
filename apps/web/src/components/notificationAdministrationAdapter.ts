import type { NotificationDeliveryAudit, ProjectRecord } from "@bim-studio/contracts";
import type { NotificationConfigurationSnapshot } from "../api";
import type { AppLocale } from "../i18n";
import type { NotificationAdministrationState } from "./notificationAdministrationModel";

/** 将后端脱敏快照转换为浏览器展示模型，凭据永远不会进入 React 状态。 */
export function toAdministrationState(
  snapshot: NotificationConfigurationSnapshot,
  audit: readonly NotificationDeliveryAudit[],
  projects: readonly ProjectRecord[],
  locale: AppLocale,
): NotificationAdministrationState {
  const channelNames = new Map(snapshot.channels.map((item) => [item.id, item.name]));
  const recipientNames = new Map(snapshot.recipients.map((item) => [item.id, item.name]));
  const templates = snapshot.templates.map((item) => ({ id: item.id, title: item.title, format: item.format }));
  const templateNames = new Map(templates.map((item) => [item.id, item.title]));
  const projectNames = new Map(projects.map((item) => [item.id, item.name]));

  return {
    channels: snapshot.channels.map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      enabled: item.enabled,
      endpointConfigured: item.endpointConfigured,
      credentialConfigured: item.secretConfigured,
      ...(item.deliveryMode ? { deliveryMode: item.deliveryMode } : {}),
      ...(item.endpointMask ? { endpointHint: item.endpointMask } : item.endpointConfigured ? { endpointHint: "已配置" } : {}),
    })),
    recipients: snapshot.recipients.map((item) => ({
      id: item.id,
      type: item.kind,
      name: item.name,
      addressHint: item.address ?? item.platformDepartmentIds?.join("、") ?? item.platformUserId ?? item.id,
      ...(item.address ? { address: item.address } : {}),
      ...(item.platformUserId ? { platformUserId: item.platformUserId } : {}),
      ...(item.platformTargetType ? { platformTargetType: item.platformTargetType } : {}),
      ...(item.platformDepartmentIds?.length ? { platformDepartmentIds: item.platformDepartmentIds } : {}),
      ...(item.memberIds?.length ? { memberIds: item.memberIds } : {}),
      ...(item.memberIds?.length ? { memberCount: item.memberIds.length } : {}),
    })),
    templates,
    rules: snapshot.rules.map((item) => ({
      id: item.id,
      name: formatEventName(item.eventType, locale),
      eventType: item.eventType,
      enabled: true,
      severity: item.severities[0] ?? "info",
      recipientIds: item.recipientIds,
      channelIds: item.channelIds,
      templateId: item.templateId,
      templateName: templateNames.get(item.templateId) ?? item.templateId,
      targetNames: targetNames(item.target, projectNames, locale),
      ...(item.target ? { target: item.target } : {}),
      ...(item.quietHours ? { quietHours: fromQuietHours(item.quietHours) } : {}),
    })),
    deliveries: audit.map((item) => ({
      id: item.id,
      createdAt: new Date(item.createdAt).toLocaleString(),
      channelName: item.channelId ? channelNames.get(item.channelId) ?? item.channelId : "—",
      recipientName: item.recipientId ? recipientNames.get(item.recipientId) ?? item.recipientId : "—",
      templateName: item.ruleId ? templateNames.get(snapshot.rules.find((rule) => rule.id === item.ruleId)?.templateId ?? "") ?? item.ruleId : item.eventId,
      status: item.status,
      ...(item.reason ? { failureReason: item.reason } : {}),
      retryable: item.status === "failed",
    })),
  };
}

function targetNames(target: { projectId?: string; sceneId?: string; objectId?: string } | undefined, projects: ReadonlyMap<string, string>, locale: AppLocale) {
  if (!target) return [locale === "zh-CN" ? "全部范围" : "All scope"];
  return [
    target.projectId ? projects.get(target.projectId) ?? target.projectId : undefined,
    target.sceneId,
    target.objectId,
  ].filter((value): value is string => Boolean(value));
}

function fromQuietHours(value: { startHour: number; endHour: number; timezoneOffsetMinutes?: number }) {
  const offset = value.timezoneOffsetMinutes ?? 480;
  return {
    start: `${String(value.startHour).padStart(2, "0")}:00`,
    end: `${String(value.endHour).padStart(2, "0")}:00`,
    timezone: `UTC${offset >= 0 ? "+" : ""}${offset / 60}`,
  };
}

function formatEventName(eventType: string, locale: AppLocale) {
  return locale === "zh-CN" ? `事件：${eventType}` : `Event: ${eventType}`;
}
