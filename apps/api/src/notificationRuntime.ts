import type { NotificationChannel, NotificationRecipient, NotificationRule, NotificationTemplate } from "@bim-studio/contracts";
import { NotificationConfigurationStore } from "./notificationConfigurationStore.js";
import { NotificationService } from "./notificationService.js";
import { ServerNotificationTransport } from "./notificationTransport.js";

/**
 * 运行时只开放一个可选发布 Webhook，避免把密钥、收件人目录或组织同步暴露到浏览器。
 * 生产环境可在启动组合根替换为数据库目录、SMTP 或企业应用适配器。
 */
export interface NotificationRuntime {
  configuration: NotificationConfigurationStore;
  service: NotificationService;
}

export async function createServerNotificationRuntime(dataDir: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<NotificationRuntime> {
  const endpoint = env.NOTIFICATION_WEBHOOK_URL?.trim();
  const channels: NotificationChannel[] = endpoint
    ? [{ id: "publish-webhook", kind: "webhook", name: "发布通知", endpoint, secretRef: "NOTIFICATION_WEBHOOK_SECRET", enabled: true }]
    : [];
  const recipients: NotificationRecipient[] = endpoint
    ? [{ id: "publish-target", kind: "external", name: "发布集成" }]
    : [];
  const templates: NotificationTemplate[] = [{
    id: "scene-published",
    format: "card-lite",
    title: "{title}",
    body: "{body}",
  }];
  const rules: NotificationRule[] = [{
    id: "scene-published",
    eventType: "scene.published",
    severities: ["info"],
    // 未配置 Webhook 时保留可编辑规则模板，但绝不生成悬空引用。
    recipientIds: endpoint ? ["publish-target"] : [],
    channelIds: endpoint ? ["publish-webhook"] : [],
    templateId: "scene-published",
    dedupeWindowSeconds: 60,
  }];
  const configuration = new NotificationConfigurationStore(
    dataDir,
    { channels, recipients, rules, templates },
    (ref) => {
      const signingSecret = env[ref];
      return signingSecret ? { kind: "webhook", signingSecret } : undefined;
    },
  );
  await configuration.init();
  const service = new NotificationService({
    ...configuration.configuration(),
    transport: new ServerNotificationTransport({
      credentials: { resolve: (ref) => configuration.credential(ref) },
    }),
  });
  return { configuration, service };
}
