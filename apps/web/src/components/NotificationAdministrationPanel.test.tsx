import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationAdministrationPanel } from "./NotificationAdministrationPanel";
import { notificationDeliverySummary, type NotificationAdministrationState } from "./notificationAdministrationModel";

const state: NotificationAdministrationState = {
  channels: [
    { id: "smtp", kind: "smtp", name: "值班邮箱", endpointHint: "ops@example.test", enabled: true, endpointConfigured: false, credentialConfigured: true },
    { id: "lark", kind: "lark", name: "产线告警群", endpointHint: "机器人", enabled: true, endpointConfigured: true, credentialConfigured: false },
    { id: "wecom", kind: "wecom", name: "设备部", endpointHint: "企业应用", enabled: true, deliveryMode: "application", endpointConfigured: false, credentialConfigured: false },
    { id: "dingtalk", kind: "dingtalk", name: "钉钉值班", endpointHint: "机器人", enabled: false, endpointConfigured: false, credentialConfigured: false },
    { id: "webhook", kind: "webhook", name: "值班编排", endpointHint: "https://…/alerts", enabled: true, endpointConfigured: true, credentialConfigured: true },
  ],
  recipients: [
    { id: "person-1", type: "person", name: "设备主管", addressHint: "ops@example.test" },
    { id: "group-1", type: "group", name: "夜班组", addressHint: "按成员目录展开", memberCount: 6 },
  ],
  templates: [{ id: "template-1", title: "严重告警模板", format: "card-lite" }],
  rules: [{
    id: "rule-1",
    name: "设备严重故障",
    eventType: "equipment.failure",
    enabled: true,
    severity: "critical",
    recipientIds: ["group-1"],
    channelIds: ["smtp"],
    templateId: "template-1",
    templateName: "严重告警模板",
    targetNames: ["夜班组"],
    quietHours: { start: "22:00", end: "07:00", timezone: "Asia/Shanghai" },
  }],
  deliveries: [
    { id: "delivery-1", createdAt: "刚刚", channelName: "值班邮箱", recipientName: "设备主管", templateName: "严重告警模板", status: "delivered", retryable: false },
    { id: "delivery-2", createdAt: "1 分钟前", channelName: "产线告警群", recipientName: "夜班组", templateName: "严重告警模板", status: "failed", failureReason: "连接超时", retryable: true },
  ],
};

describe("NotificationAdministrationPanel", () => {
  it("presents channels, recipients, rules and delivery evidence without exposing credentials", () => {
    const html = renderToStaticMarkup(<NotificationAdministrationPanel state={state} t={(zh) => zh} />);

    expect(html).toContain("通知与推送");
    expect(html).toContain("钉钉值班");
    expect(html).toContain("群机器人用于群通知；企业应用用于个人/部门。");
    expect(html).toContain("夜班组");
    expect(html).toContain("添加收件人");
    expect(html).toContain("添加规则");
    expect(html).toContain("1 个渠道");
    expect(html).toContain("设备严重故障");
    expect(html).toContain("连接超时");
    expect(html).toContain("重试");
    expect(html).not.toContain("secret-value");
  });

  it("summarizes delivery states for the log header", () => {
    expect(notificationDeliverySummary(state)).toEqual({ delivered: 1, failed: 1, suppressed: 0, skipped: 0 });
  });
});
