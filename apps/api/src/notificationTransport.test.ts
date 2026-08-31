import { describe, expect, it, vi } from "vitest";
import type { NotificationChannel, NotificationCredential, NotificationRecipient } from "@bim-studio/contracts";
import { NotificationTokenCache } from "./notificationTokenCache.js";
import { ServerNotificationTransport } from "./notificationTransport.js";

const recipient: NotificationRecipient = { id: "operator", kind: "person", name: "值班员", address: "ops@example.test", platformUserId: "user-1" };

describe("ServerNotificationTransport", () => {
  it("uses structured SMTP credentials through the injected SMTP boundary", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const credential: NotificationCredential = { kind: "smtp", host: "127.0.0.1", port: 2525, from: "noreply@example.test" };
    const channel: NotificationChannel = { id: "mail", kind: "smtp", name: "邮箱", secretRef: "mail", enabled: true };
    const transport = createTransport({ mail: credential }, { smtp: { send } });

    await transport.deliver({ channel, recipients: [recipient], title: "告警", body: "温度超限" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ credential, recipients: [recipient] }));
  });

  it("gets and caches a Lark tenant token before sending by open_id", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { code: 0, tenant_access_token: "tenant", expire: 7200 } })
      .mockResolvedValue({ status: 200, body: { code: 0 } });
    const credential: NotificationCredential = { kind: "lark", appId: "app", appSecret: "secret", baseUrl: "http://127.0.0.1/lark" };
    const channel: NotificationChannel = { id: "lark", kind: "lark", name: "飞书应用", secretRef: "lark", enabled: true, deliveryMode: "application" };
    const transport = createTransport({ lark: credential }, { http: { request }, tokens: new NotificationTokenCache() });

    await transport.deliver({ channel, recipients: [recipient], title: "告警", body: "温度超限" });
    await transport.deliver({ channel, recipients: [recipient], title: "告警", body: "温度超限" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][0]).toContain("receive_id_type=open_id");
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ receive_id: "user-1", msg_type: "interactive" });
  });

  it("sends WeCom users and departments in one application message", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { errcode: 0, access_token: "token", expires_in: 7200 } })
      .mockResolvedValueOnce({ status: 200, body: { errcode: 0 } });
    const credential: NotificationCredential = { kind: "wecom", corpId: "corp", corpSecret: "secret", agentId: 1001, baseUrl: "http://127.0.0.1/wecom" };
    const channel: NotificationChannel = { id: "wecom", kind: "wecom", name: "企微应用", secretRef: "wecom", enabled: true, deliveryMode: "application" };
    const department: NotificationRecipient = { id: "maintenance", kind: "group", name: "维修部", platformDepartmentIds: ["12"] };

    await createTransport({ wecom: credential }, { http: { request } }).deliver({ channel, recipients: [recipient, department], title: "告警", body: "温度超限" });

    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ touser: "user-1", toparty: "12", agentid: 1001 });
  });

  it("sends DingTalk internal work notifications by user and department", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { errcode: 0, access_token: "token", expires_in: 7200 } })
      .mockResolvedValueOnce({ status: 200, body: { errcode: 0 } });
    const credential: NotificationCredential = { kind: "dingtalk", appKey: "app", appSecret: "secret", agentId: 1001, baseUrl: "http://127.0.0.1/dingtalk" };
    const channel: NotificationChannel = { id: "dingtalk", kind: "dingtalk", name: "钉钉应用", secretRef: "dingtalk", enabled: true, deliveryMode: "application" };
    const department: NotificationRecipient = { id: "maintenance", kind: "group", name: "维修部", platformDepartmentIds: ["12"] };

    await createTransport({ dingtalk: credential }, { http: { request } }).deliver({ channel, recipients: [recipient, department], title: "告警", body: "温度超限" });

    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ agent_id: 1001, userid_list: "user-1", dept_id_list: "12" });
  });

  it("keeps bot group Webhooks and signs generic Webhook requests", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const channel: NotificationChannel = { id: "hook", kind: "webhook", name: "集成", endpoint: "http://127.0.0.1/mock", secretRef: "hook", enabled: true };
    const transport = createTransport({ hook: { kind: "webhook", signingSecret: "local-test-secret" } }, { http: { request } });

    await transport.deliver({ channel, recipients: [recipient], title: "发布", body: "完成" });

    expect(request.mock.calls[0][1].headers).toMatchObject({ "x-bim-studio-signature": expect.any(String) });
  });
});

function createTransport(credentials: Record<string, NotificationCredential>, dependencies: ConstructorParameters<typeof ServerNotificationTransport>[0] = { credentials: { resolve: () => undefined } }): ServerNotificationTransport {
  return new ServerNotificationTransport({ ...dependencies, credentials: { resolve: (ref) => credentials[ref] } });
}
