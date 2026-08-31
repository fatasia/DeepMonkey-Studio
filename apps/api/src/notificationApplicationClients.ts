import type {
  DingtalkNotificationCredential,
  LarkNotificationCredential,
  NotificationCredential,
  NotificationRecipient,
  WecomNotificationCredential,
} from "@bim-studio/contracts";
import { appendPath, requestJson, type NotificationHttpClient } from "./notificationHttpClient.js";
import { NotificationTokenCache } from "./notificationTokenCache.js";
import { NotificationTransportError } from "./notificationTransportError.js";

export interface ApplicationMessage {
  recipients: readonly NotificationRecipient[];
  title: string;
  body: string;
}

export async function sendApplicationMessage(
  credential: NotificationCredential,
  message: ApplicationMessage,
  http: NotificationHttpClient,
  tokens: NotificationTokenCache,
): Promise<void> {
  if (credential.kind === "lark") return sendLark(credential, message, http, tokens);
  if (credential.kind === "wecom") return sendWecom(credential, message, http, tokens);
  if (credential.kind === "dingtalk") return sendDingtalk(credential, message, http, tokens);
  throw new NotificationTransportError("application_credential_kind_invalid", false);
}

async function sendLark(
  credential: LarkNotificationCredential,
  message: ApplicationMessage,
  http: NotificationHttpClient,
  tokens: NotificationTokenCache,
): Promise<void> {
  const baseUrl = credential.baseUrl ?? "https://open.feishu.cn";
  const token = await tokens.get(`lark:${credential.appId}:${baseUrl}`, async () => {
    const response = await requestJson(http, appendPath(baseUrl, "/open-apis/auth/v3/tenant_access_token/internal"), jsonPost({ app_id: credential.appId, app_secret: credential.appSecret }));
    if (response.code !== 0 || typeof response.tenant_access_token !== "string") throw providerError("lark_token", response.code);
    return { value: response.tenant_access_token, expiresInSeconds: numberValue(response.expire, 7_200) };
  });
  for (const recipient of message.recipients) {
    const receiveId = recipient.platformUserId ?? recipient.address;
    if (!receiveId) throw new NotificationTransportError("lark_recipient_missing", false);
    const receiveType = recipient.platformTargetType ?? "open_id";
    const response = await requestJson(
      http,
      appendPath(baseUrl, `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveType)}`),
      jsonPost(larkCard(receiveId, message), { authorization: `Bearer ${token}` }),
    );
    if (response.code !== 0) throw providerError("lark_send", response.code);
  }
}

async function sendWecom(
  credential: WecomNotificationCredential,
  message: ApplicationMessage,
  http: NotificationHttpClient,
  tokens: NotificationTokenCache,
): Promise<void> {
  const baseUrl = credential.baseUrl ?? "https://qyapi.weixin.qq.com";
  const token = await tokens.get(`wecom:${credential.corpId}:${baseUrl}`, async () => {
    const query = `?corpid=${encodeURIComponent(credential.corpId)}&corpsecret=${encodeURIComponent(credential.corpSecret)}`;
    const response = await requestJson(http, appendPath(baseUrl, `/cgi-bin/gettoken${query}`), { method: "GET" });
    if (response.errcode !== 0 || typeof response.access_token !== "string") throw providerError("wecom_token", response.errcode);
    return { value: response.access_token, expiresInSeconds: numberValue(response.expires_in, 7_200) };
  });
  const users = message.recipients.map((item) => item.platformUserId).filter(isText);
  const departments = message.recipients.flatMap((item) => item.platformDepartmentIds ?? []);
  if (!users.length && !departments.length) throw new NotificationTransportError("wecom_recipient_missing", false);
  const response = await requestJson(http, appendPath(baseUrl, `/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`), jsonPost({
    ...(users.length ? { touser: users.join("|") } : {}),
    ...(departments.length ? { toparty: departments.join("|") } : {}),
    msgtype: "text", agentid: credential.agentId, text: { content: fullText(message) }, safe: 0,
  }));
  if (response.errcode !== 0) throw providerError("wecom_send", response.errcode);
}

async function sendDingtalk(
  credential: DingtalkNotificationCredential,
  message: ApplicationMessage,
  http: NotificationHttpClient,
  tokens: NotificationTokenCache,
): Promise<void> {
  const baseUrl = credential.baseUrl ?? "https://oapi.dingtalk.com";
  const token = await tokens.get(`dingtalk:${credential.appKey}:${baseUrl}`, async () => {
    const query = `?appkey=${encodeURIComponent(credential.appKey)}&appsecret=${encodeURIComponent(credential.appSecret)}`;
    const response = await requestJson(http, appendPath(baseUrl, `/gettoken${query}`), { method: "GET" });
    if (response.errcode !== 0 || typeof response.access_token !== "string") throw providerError("dingtalk_token", response.errcode);
    return { value: response.access_token, expiresInSeconds: numberValue(response.expires_in, 7_200) };
  });
  const users = message.recipients.map((item) => item.platformUserId).filter(isText);
  const departments = message.recipients.flatMap((item) => item.platformDepartmentIds ?? []);
  if (!users.length && !departments.length) throw new NotificationTransportError("dingtalk_recipient_missing", false);
  const response = await requestJson(http, appendPath(baseUrl, `/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(token)}`), jsonPost({
    agent_id: credential.agentId,
    ...(users.length ? { userid_list: users.join(",") } : {}),
    ...(departments.length ? { dept_id_list: departments.join(",") } : {}),
    msg: { msgtype: "text", text: { content: fullText(message) } },
  }));
  if (response.errcode !== 0) throw providerError("dingtalk_send", response.errcode);
}

function larkCard(receiveId: string, message: ApplicationMessage): Record<string, unknown> {
  return {
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify({ config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: message.title } }, elements: [{ tag: "markdown", content: message.body }] }),
  };
}

function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

function providerError(prefix: string, code: unknown): NotificationTransportError {
  const retryable = code === 99991663 || code === 88_001_006;
  return new NotificationTransportError(`${prefix}_${String(code ?? "unknown")}`, retryable);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function fullText(message: ApplicationMessage): string {
  return `${message.title}\n${message.body}`;
}
