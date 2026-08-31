import { AlertTriangle, CheckCircle2, Clock3, RotateCcw } from "lucide-react";
import type { NotificationAdministrationState, NotificationDeliveryStatus } from "./notificationAdministrationModel";
import { notificationDeliverySummary } from "./notificationAdministrationModel";

interface NotificationDeliveryLogProps {
  state: NotificationAdministrationState;
  busyDeliveryId?: string;
  canRetry: boolean;
  onRetry: (id: string) => void;
  t: (zh: string, en: string) => string;
}

export function NotificationDeliveryLog({
  state,
  busyDeliveryId,
  canRetry,
  onRetry,
  t,
}: NotificationDeliveryLogProps) {
  const summary = notificationDeliverySummary(state);
  const notDelivered = summary.suppressed + summary.skipped;

  return (
    <section className="notification-section notification-deliveries">
      <header>
        <span>
          <Clock3 size={17} />
          <strong>{t("投递日志", "Delivery log")}</strong>
        </span>
        <small>
          {t(
            `${summary.delivered} 成功 · ${summary.failed} 失败 · ${notDelivered} 未投递`,
            `${summary.delivered} delivered · ${summary.failed} failed · ${notDelivered} not sent`,
          )}
        </small>
      </header>
      <div className="notification-delivery-list">
        {state.deliveries.map((delivery) => (
          <article key={delivery.id} className={delivery.status}>
            <i>{statusIcon(delivery.status)}</i>
            <span>
              <strong>{delivery.templateName} → {delivery.recipientName}</strong>
              <small>
                {delivery.channelName} · {delivery.createdAt}
                {delivery.failureReason ? ` · ${delivery.failureReason}` : ""}
              </small>
            </span>
            <b>{statusLabel(delivery.status, t)}</b>
            {delivery.retryable && (
              <button
                disabled={Boolean(busyDeliveryId) || !canRetry}
                onClick={() => onRetry(delivery.id)}
              >
                <RotateCcw size={13} />
                {busyDeliveryId === delivery.id ? t("重试中", "Retrying") : t("重试", "Retry")}
              </button>
            )}
          </article>
        ))}
        {!state.deliveries.length && (
          <div className="notification-empty">
            {t(
              "尚无投递记录。测试发送和规则触发都会留下状态证据。",
              "No delivery records yet. Tests and rule triggers leave delivery evidence here.",
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function statusIcon(status: NotificationDeliveryStatus) {
  if (status === "delivered") return <CheckCircle2 size={16} />;
  if (status === "failed") return <AlertTriangle size={16} />;
  return <Clock3 size={16} />;
}

function statusLabel(status: NotificationDeliveryStatus, t: (zh: string, en: string) => string) {
  if (status === "delivered") return t("已送达", "Delivered");
  if (status === "failed") return t("失败", "Failed");
  return status === "suppressed" ? t("静默抑制", "Suppressed") : t("已跳过", "Skipped");
}
