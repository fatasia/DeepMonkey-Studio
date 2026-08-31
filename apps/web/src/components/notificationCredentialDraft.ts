import type { NotificationCredential } from "@bim-studio/contracts";
import type { NotificationChannelKind } from "./notificationAdministrationModel";

export interface NotificationCredentialDrafts {
  smtp: { host: string; port: string; from: string; username: string; password: string; secure: boolean };
  lark: { appId: string; appSecret: string };
  wecom: { corpId: string; corpSecret: string; agentId: string };
  dingtalk: { appKey: string; appSecret: string; agentId: string };
  webhookSecret: string;
}

export function buildCredential(kind: NotificationChannelKind, application: boolean, draft: NotificationCredentialDrafts): NotificationCredential | undefined {
  const { smtp, lark, wecom, dingtalk, webhookSecret } = draft;
  if (kind === "smtp" && smtp.host && smtp.port && smtp.from) {
    return { kind, host: smtp.host, port: Number(smtp.port), from: smtp.from, secure: smtp.secure, ...(smtp.username ? { username: smtp.username } : {}), ...(smtp.password ? { password: smtp.password } : {}) };
  }
  if (kind === "lark" && application && lark.appId && lark.appSecret) return { kind, ...lark };
  if (kind === "wecom" && application && wecom.corpId && wecom.corpSecret && Number(wecom.agentId)) return { kind, corpId: wecom.corpId, corpSecret: wecom.corpSecret, agentId: Number(wecom.agentId) };
  if (kind === "dingtalk" && application && dingtalk.appKey && dingtalk.appSecret && Number(dingtalk.agentId)) return { kind, appKey: dingtalk.appKey, appSecret: dingtalk.appSecret, agentId: Number(dingtalk.agentId) };
  if (kind === "webhook" && webhookSecret) return { kind, signingSecret: webhookSecret };
  return undefined;
}

export function credentialRequired(kind: NotificationChannelKind, deliveryMode: "bot" | "application" | undefined) {
  return kind === "smtp" || deliveryMode === "application";
}
