import { useEffect, useState } from "react";
import { AlertTriangle, BellRing, LoaderCircle, RefreshCw } from "lucide-react";
import type {
  NotificationAdministrationState,
  NotificationChannelSaveRequest,
  NotificationChannelView,
  NotificationRecipientSaveRequest,
  NotificationRecipientView,
  NotificationRuleSaveRequest,
} from "./notificationAdministrationModel";
import { createNotificationDraft } from "./notificationAdministrationModel";
import { NotificationChannelSettings } from "./NotificationChannelSettings";
import { NotificationDeliveryLog } from "./NotificationDeliveryLog";
import { NotificationRecipientSettings } from "./NotificationRecipientSettings";
import { NotificationRoutingSettings } from "./NotificationRoutingSettings";
import "./NotificationAdministrationPanel.css";

export interface NotificationAdministrationActions {
  saveChannel?: (value: NotificationChannelSaveRequest) => Promise<NotificationChannelView>;
  testChannel?: (channelId: string) => Promise<Pick<NotificationChannelView, "lastTest">>;
  saveRecipient?: (value: NotificationRecipientSaveRequest) => Promise<NotificationRecipientView>;
  deleteRecipient?: (recipientId: string) => Promise<void>;
  saveRule?: (value: NotificationRuleSaveRequest) => Promise<NotificationRuleSaveRequest["rule"]>;
  retryDelivery?: (deliveryId: string) => Promise<void>;
  reload?: () => Promise<void>;
}

interface Props {
  state?: NotificationAdministrationState;
  loading?: boolean;
  error?: string;
  actions?: NotificationAdministrationActions;
  t: (zh: string, en: string) => string;
}

/**
 * 页面只渲染已由服务返回的配置。没有对应写 API 时禁用操作，
 * 防止浏览器草稿被误认为已经持久化。
 */
export function NotificationAdministrationPanel({
  state,
  loading = false,
  error,
  actions,
  t,
}: Props) {
  const [draft, setDraft] = useState<NotificationAdministrationState | undefined>(
    state && createNotificationDraft(state),
  );
  const [busyId, setBusyId] = useState<string>();
  const [feedback, setFeedback] = useState<string>();

  useEffect(() => setDraft(state && createNotificationDraft(state)), [state]);

  async function saveChannel(value: NotificationChannelSaveRequest) {
    if (!draft || !actions?.saveChannel) return;
    setBusyId(value.channel.id);
    try {
      const saved = await actions.saveChannel(value);
      setDraft((current) => current && {
        ...current,
        channels: current.channels.some((item) => item.id === saved.id)
          ? current.channels.map((item) => item.id === saved.id ? saved : item)
          : [...current.channels, saved],
      });
      setFeedback(t("渠道配置已保存", "Channel configuration saved"));
    } catch (reason) {
      setFeedback(errorMessage(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  async function testChannel(channelId: string) {
    if (!draft || !actions?.testChannel) return;
    setBusyId(channelId);
    try {
      const result = await actions.testChannel(channelId);
      setDraft((current) => current && {
        ...current,
        channels: current.channels.map((channel) => channel.id === channelId
          ? { ...channel, ...result }
          : channel),
      });
      setFeedback(result.lastTest?.status === "passed"
        ? t("测试消息已投递", "Test message delivered")
        : t("测试未送达，请检查投递日志", "Test was not delivered; check the log"));
    } catch (reason) {
      setFeedback(errorMessage(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  async function saveRecipient(value: NotificationRecipientSaveRequest) {
    if (!draft || !actions?.saveRecipient) return;
    setBusyId(value.recipient.id);
    try {
      const saved = await actions.saveRecipient(value);
      setDraft((current) => current && { ...current, recipients: current.recipients.some((item) => item.id === saved.id) ? current.recipients.map((item) => item.id === saved.id ? saved : item) : [...current.recipients, saved] });
      setFeedback(t("收件人已保存", "Recipient saved"));
    } catch (reason) {
      setFeedback(errorMessage(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  async function deleteRecipient(recipientId: string) {
    if (!draft || !actions?.deleteRecipient) return;
    setBusyId(recipientId);
    try {
      await actions.deleteRecipient(recipientId);
      setDraft((current) => current && { ...current, recipients: current.recipients.filter((item) => item.id !== recipientId) });
      setFeedback(t("收件人已删除", "Recipient deleted"));
    } catch (reason) {
      setFeedback(errorMessage(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  async function saveRule(value: NotificationRuleSaveRequest) {
    if (!draft || !actions?.saveRule) return;
    setBusyId(value.rule.id);
    try {
      const saved = await actions.saveRule(value);
      setDraft((current) => current && {
        ...current,
        rules: current.rules.some((item) => item.id === saved.id) ? current.rules.map((item) => item.id === saved.id ? saved : item) : [...current.rules, saved],
      });
      setFeedback(t("通知规则已保存", "Notification rule saved"));
    } catch (reason) {
      setFeedback(errorMessage(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  async function retryDelivery(deliveryId: string) {
    if (!draft || !actions?.retryDelivery) return;
    setBusyId(deliveryId);
    try {
      await actions.retryDelivery(deliveryId);
      setFeedback(t("已提交重试，请等待新的投递记录。", "Retry submitted; wait for a new delivery record."));
    } catch (reason) {
      setFeedback(errorMessage(reason));
    } finally {
      setBusyId(undefined);
    }
  }

  if (loading && !draft) {
    return <div className="notification-loading"><LoaderCircle className="spin" />{t("正在读取通知配置", "Loading notification settings")}</div>;
  }

  if (!draft) {
    const reload = actions?.reload;
    return <div className="notification-unavailable">
      <AlertTriangle size={20} />
      <strong>{t("通知配置暂不可用", "Notification settings unavailable")}</strong>
      <span>{error ?? t("服务尚未返回可编辑的通知合同。", "The service has not returned an editable notification contract.")}</span>
      {reload && <button onClick={() => void reload()}><RefreshCw size={14} />{t("重试", "Retry")}</button>}
    </div>;
  }

  return <div className="notification-administration">
    <header className="notification-overview">
      <span>
        <BellRing size={20} />
        <span>
          <strong>{t("通知与推送", "Notifications & delivery")}</strong>
          <small>{t("渠道凭据、目标路由、静默策略和投递证据集中管理。", "Manage credentials, routing, quiet policy and delivery evidence in one place.")}</small>
        </span>
      </span>
      <em>{draft.channels.filter((channel) => channel.enabled).length}/{draft.channels.length} {t("渠道已启用", "channels enabled")}</em>
    </header>
    {feedback && <div className="notification-feedback" role="status">{feedback}</div>}
    <NotificationChannelSettings
      channels={draft.channels}
      {...(busyId ? { busyChannelId: busyId } : {})}
      canConfigure={Boolean(actions?.saveChannel)}
      canTest={Boolean(actions?.testChannel)}
      onSave={saveChannel}
      onTest={testChannel}
      t={t}
    />
    <div className="notification-routing-layout">
      <NotificationRecipientSettings
        recipients={draft.recipients}
        {...(busyId ? { busyId } : {})}
        canSave={Boolean(actions?.saveRecipient)}
        onSave={saveRecipient}
        onDelete={deleteRecipient}
        t={t}
      />
      <NotificationRoutingSettings
        channels={draft.channels}
        recipients={draft.recipients}
        rules={draft.rules}
        templates={draft.templates}
        canSave={Boolean(actions?.saveRule)}
        onSaveRule={saveRule}
        t={t}
      />
    </div>
    <NotificationDeliveryLog
      state={draft}
      {...(busyId ? { busyDeliveryId: busyId } : {})}
      canRetry={Boolean(actions?.retryDelivery)}
      onRetry={retryDelivery}
      t={t}
    />
  </div>;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
