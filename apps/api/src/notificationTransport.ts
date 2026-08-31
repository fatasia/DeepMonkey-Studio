import { createHmac } from "node:crypto";
import type { NotificationChannel, NotificationCredential, NotificationRecipient } from "@bim-studio/contracts";
import { sendApplicationMessage } from "./notificationApplicationClients.js";
import { fetchNotificationHttpClient, type NotificationHttpClient } from "./notificationHttpClient.js";
import { nodemailerNotificationSmtpClient, type NotificationSmtpClient } from "./notificationSmtpClient.js";
import type { NotificationTransport } from "./notificationService.js";
import { NotificationTokenCache } from "./notificationTokenCache.js";
import { NotificationTransportError } from "./notificationTransportError.js";

export interface NotificationCredentialResolver {
  resolve(ref: string): NotificationCredential | undefined;
}

export interface ServerNotificationTransportOptions {
  credentials: NotificationCredentialResolver;
  http?: NotificationHttpClient;
  smtp?: NotificationSmtpClient;
  tokens?: NotificationTokenCache;
}

/** 服务端统一渠道适配：机器人 Webhook 与企业应用定向消息使用不同协议边界。 */
export class ServerNotificationTransport implements NotificationTransport {
  private readonly http: NotificationHttpClient;
  private readonly smtp: NotificationSmtpClient;
  private readonly tokens: NotificationTokenCache;

  constructor(private readonly options: ServerNotificationTransportOptions) {
    this.http = options.http ?? fetchNotificationHttpClient;
    this.smtp = options.smtp ?? nodemailerNotificationSmtpClient;
    this.tokens = options.tokens ?? new NotificationTokenCache();
  }

  async deliver(input: Parameters<NotificationTransport["deliver"]>[0]): Promise<void> {
    if (input.channel.kind === "smtp") return this.sendSmtp(input.channel, input.recipients, input.title, input.body);
    if (input.channel.deliveryMode === "application") return this.sendApplication(input.channel, input.recipients, input.title, input.body);
    return this.sendWebhook(input.channel, input.recipients, input.title, input.body);
  }

  private async sendSmtp(channel: NotificationChannel, recipients: readonly NotificationRecipient[], title: string, body: string): Promise<void> {
    const credential = this.requireCredential(channel, "smtp");
    await this.smtp.send({ credential, recipients, title, body });
  }

  private async sendApplication(channel: NotificationChannel, recipients: readonly NotificationRecipient[], title: string, body: string): Promise<void> {
    const credential = this.requireCredential(channel, channel.kind);
    await sendApplicationMessage(credential, { recipients, title, body }, this.http, this.tokens);
  }

  private async sendWebhook(channel: NotificationChannel, recipients: readonly NotificationRecipient[], title: string, body: string): Promise<void> {
    if (!channel.endpoint) throw new NotificationTransportError("channel_endpoint_missing", false);
    const payload = webhookPayload(channel, recipients[0], title, body);
    const credential = channel.secretRef ? this.options.credentials.resolve(channel.secretRef) : undefined;
    const headers = {
      "content-type": "application/json",
      ...(credential?.kind === "webhook" && channel.kind === "webhook"
        ? { "x-bim-studio-signature": createHmac("sha256", credential.signingSecret).update(JSON.stringify(payload)).digest("hex") }
        : {}),
    };
    const response = await this.http.request(channel.endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
    if (response.status < 200 || response.status >= 300) {
      throw new NotificationTransportError(`channel_http_${response.status}`, response.status === 429 || response.status >= 500);
    }
  }

  private requireCredential<TKind extends NotificationCredential["kind"]>(channel: NotificationChannel, kind: TKind): Extract<NotificationCredential, { kind: TKind }> {
    if (!channel.secretRef) throw new NotificationTransportError("channel_credential_missing", false);
    const credential = this.options.credentials.resolve(channel.secretRef);
    if (!credential || credential.kind !== kind) throw new NotificationTransportError("channel_credential_invalid", false);
    return credential as Extract<NotificationCredential, { kind: TKind }>;
  }
}

function webhookPayload(channel: NotificationChannel, recipient: NotificationRecipient | undefined, title: string, body: string): Record<string, unknown> {
  const content = `${title}\n${body}`;
  const mentions = recipient?.mention?.platformUserIds ?? [];
  const mentionAll = recipient?.mention?.all ?? false;
  if (channel.kind === "lark") return { msg_type: "text", content: { text: `${content}${larkMentions(mentionAll, mentions)}` } };
  if (channel.kind === "wecom") return { msgtype: "text", text: { content, ...(mentionAll || mentions.length ? { mentioned_list: [...(mentionAll ? ["@all"] : []), ...mentions] } : {}) } };
  if (channel.kind === "dingtalk") return { msgtype: "text", text: { content }, ...(mentionAll || mentions.length ? { at: { ...(mentionAll ? { isAtAll: true } : {}), ...(mentions.length ? { atUserIds: mentions } : {}) } } : {}) };
  return { title, body, recipients: recipient ? [recipient.address ?? recipient.id] : [] };
}

function larkMentions(mentionAll: boolean, mentions: readonly string[]): string {
  return `${mentionAll ? "\n<at user_id=\"all\">所有人</at>" : ""}${mentions.map((id) => `\n<at user_id=\"${id}\">${id}</at>`).join("")}`;
}
