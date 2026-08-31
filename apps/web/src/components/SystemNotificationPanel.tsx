import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type {
  NotificationDeliveryAudit,
  NotificationRecipient,
  NotificationRule,
  ProjectRecord,
} from "@bim-studio/contracts";
import {
  api,
  type NotificationConfigurationSnapshot,
} from "../api";
import type { AppLocale } from "../i18n";
import {
  NotificationAdministrationPanel,
  type NotificationAdministrationActions,
} from "./NotificationAdministrationPanel";
import type {
  NotificationChannelSaveRequest,
  NotificationChannelView,
  NotificationRecipientSaveRequest,
  NotificationRecipientView,
  NotificationRuleSaveRequest,
  NotificationRuleView,
} from "./notificationAdministrationModel";
import { toAdministrationState } from "./notificationAdministrationAdapter";

interface Props {
  locale: AppLocale;
  projects: readonly ProjectRecord[];
  t: (zh: string, en: string) => string;
}

/** 将服务端脱敏快照转换为纯展示模型，任何凭据都不进入 React 状态。 */
export function SystemNotificationPanel({ locale, projects, t }: Props) {
  const [snapshot, setSnapshot] = useState<NotificationConfigurationSnapshot>();
  const [audit, setAudit] = useState<NotificationDeliveryAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextSnapshot, nextAudit] = await Promise.all([
        api.getNotificationSnapshot(),
        api.listNotificationAudit(),
      ]);
      setSnapshot(nextSnapshot);
      setAudit(nextAudit);
      return nextSnapshot;
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const state = useMemo(
    () => snapshot && toAdministrationState(snapshot, audit, projects, locale),
    [audit, locale, projects, snapshot],
  );

  const actions = useMemo<NotificationAdministrationActions>(() => ({
    reload: async () => {
      await load();
    },
    saveChannel: async (value) => saveChannel(value, audit, projects, locale, load),
    saveRecipient: async (value) => saveRecipient(value, audit, projects, locale, load),
    deleteRecipient: async (recipientId) => deleteRecipient(recipientId, load),
    saveRule: async (value) => saveRule(value, snapshot, audit, projects, locale, load),
    testChannel: async (channelId) => testChannel(channelId, snapshot, setAudit, t),
  }), [audit, load, locale, projects, snapshot, t]);

  return <NotificationAdministrationPanel
    {...(state ? { state } : {})}
    loading={loading}
    {...(error ? { error } : {})}
    actions={actions}
    t={t}
  />;
}

async function saveRecipient(
  value: NotificationRecipientSaveRequest,
  audit: readonly NotificationDeliveryAudit[],
  projects: readonly ProjectRecord[],
  locale: AppLocale,
  load: () => Promise<NotificationConfigurationSnapshot | undefined>,
): Promise<NotificationRecipientView> {
  const recipient = value.recipient;
  const input: NotificationRecipient = {
    id: recipient.id,
    kind: recipient.type,
    name: recipient.name,
    ...(recipient.address ? { address: recipient.address } : {}),
    ...(recipient.platformUserId ? { platformUserId: recipient.platformUserId } : {}),
    ...(recipient.platformTargetType ? { platformTargetType: recipient.platformTargetType } : {}),
    ...(recipient.platformDepartmentIds?.length ? { platformDepartmentIds: recipient.platformDepartmentIds } : {}),
    ...(recipient.memberIds?.length ? { memberIds: recipient.memberIds } : {}),
  };
  if (value.create) await api.createNotificationRecipient(input);
  else await api.saveNotificationRecipient(input);
  const next = await load();
  const saved = next && toAdministrationState(next, audit, projects, locale)
    .recipients.find((item) => item.id === recipient.id);
  if (!saved) throw new Error("收件人保存后未在配置快照中找到");
  return saved;
}

async function deleteRecipient(
  recipientId: string,
  load: () => Promise<NotificationConfigurationSnapshot | undefined>,
): Promise<void> {
  await api.deleteNotificationRecipient(recipientId);
  await load();
}

async function saveChannel(
  value: NotificationChannelSaveRequest,
  audit: readonly NotificationDeliveryAudit[],
  projects: readonly ProjectRecord[],
  locale: AppLocale,
  load: () => Promise<NotificationConfigurationSnapshot | undefined>,
): Promise<NotificationChannelView> {
  const input = {
    id: value.channel.id,
    kind: value.channel.kind,
    name: value.channel.name,
    enabled: value.channel.enabled,
    ...(value.channel.deliveryMode ? { deliveryMode: value.channel.deliveryMode } : {}),
    ...(value.endpoint ? { endpoint: value.endpoint } : {}),
    ...(value.credential ? { credential: value.credential } : {}),
  };
  if (value.create) await api.createNotificationChannel(input);
  else await api.saveNotificationChannel(input);
  const next = await load();
  const channel = next && toAdministrationState(next, audit, projects, locale)
    .channels.find((item) => item.id === value.channel.id);
  if (!channel) throw new Error("渠道保存后未在脱敏快照中找到");
  return channel;
}

async function saveRule(
  value: NotificationRuleSaveRequest,
  snapshot: NotificationConfigurationSnapshot | undefined,
  audit: readonly NotificationDeliveryAudit[],
  projects: readonly ProjectRecord[],
  locale: AppLocale,
  load: () => Promise<NotificationConfigurationSnapshot | undefined>,
): Promise<NotificationRuleView> {
  if (!snapshot) throw new Error("通知配置尚未加载完成");
  const rule = value.rule;
  const input: NotificationRule = {
    id: rule.id,
    eventType: rule.eventType,
    severities: [rule.severity],
    recipientIds: rule.recipientIds,
    channelIds: rule.channelIds,
    templateId: rule.templateId,
    ...(rule.target ? { target: rule.target } : {}),
    ...(rule.quietHours ? { quietHours: toQuietHours(rule.quietHours) } : {}),
  };
  if (value.create) await api.createNotificationRule(input);
  else await api.saveNotificationRule(input);
  const next = await load();
  const savedRule = next && toAdministrationState(next, audit, projects, locale)
    .rules.find((item) => item.id === value.rule.id);
  if (!savedRule) throw new Error("规则保存后未在配置快照中找到");
  return savedRule;
}

async function testChannel(
  channelId: string,
  snapshot: NotificationConfigurationSnapshot | undefined,
  setAudit: Dispatch<SetStateAction<NotificationDeliveryAudit[]>>,
  t: Props["t"],
) {
  const rule = snapshot?.rules.find((item) => item.channelIds.includes(channelId));
  if (!rule) throw new Error(t("该渠道尚未被任何规则引用，无法生成真实测试事件。", "This channel is not referenced by a rule, so no real test event can be generated."));
  const result = await api.testNotification({
    id: `notification-test-${Date.now()}`,
    type: rule.eventType,
    severity: rule.severities[0] ?? "info",
    title: t("通知渠道测试", "Notification channel test"),
    body: t("这是按当前规则路由的真实测试事件。", "This is a real test event routed by the current rule."),
    occurredAt: new Date().toISOString(),
    ...(rule.target ? { target: rule.target } : {}),
  });
  setAudit((current) => [...result.audit, ...current].slice(0, 200));
  const record = result.audit.find((item) => item.channelId === channelId) ?? result.audit[0];
  return {
    lastTest: {
      status: record?.status === "delivered" ? "passed" as const : "failed" as const,
      message: record?.reason ?? deliveryLabel(record?.status, t),
      at: new Date().toLocaleTimeString(),
    },
  };
}

function toQuietHours(value: { start: string; end: string }) {
  return { startHour: Number(value.start.slice(0, 2)), endHour: Number(value.end.slice(0, 2)), timezoneOffsetMinutes: 480 };
}

function deliveryLabel(status: NotificationDeliveryAudit["status"] | undefined, t: Props["t"]) {
  if (status === "delivered") return t("测试消息已送达", "Test message delivered");
  if (status === "suppressed") return t("测试被静默策略抑制", "Test was suppressed by quiet policy");
  if (status === "skipped") return t("测试未匹配投递条件", "Test did not match delivery conditions");
  return t("测试未产生投递记录", "The test did not produce a delivery record");
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
