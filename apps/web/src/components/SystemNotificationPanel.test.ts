import { describe, expect, it } from "vitest";
import type { NotificationConfigurationSnapshot } from "../api";
import { toAdministrationState } from "./notificationAdministrationAdapter";

describe("toAdministrationState", () => {
  it("uses the redacted snapshot and preserves delivery evidence", () => {
    const snapshot: NotificationConfigurationSnapshot = {
      channels: [{
        id: "lark-ops",
        kind: "lark",
        name: "运维告警群",
        enabled: true,
        endpointConfigured: true,
        endpointMask: "http…hook",
        secretConfigured: true,
      }],
      recipients: [{
        id: "night-shift",
        kind: "group",
        name: "夜班组",
        platformDepartmentIds: ["department-7"],
        memberIds: ["u-1", "u-2"],
      }],
      templates: [{ id: "alarm", format: "card-lite", title: "设备告警", body: "{body}" }],
      rules: [{
        id: "equipment-failure",
        eventType: "equipment.failure",
        severities: ["critical"],
        recipientIds: ["night-shift"],
        channelIds: ["lark-ops"],
        templateId: "alarm",
      }],
    };
    const state = toAdministrationState(snapshot, [{
      id: "audit-1",
      eventId: "event-1",
      ruleId: "equipment-failure",
      channelId: "lark-ops",
      recipientId: "night-shift",
      status: "failed",
      reason: "连接超时",
      attempts: 2,
      createdAt: "2026-08-31T08:00:00.000Z",
    }], [], "zh-CN");

    expect(state.channels[0]).toMatchObject({ endpointHint: "http…hook", endpointConfigured: true, credentialConfigured: true });
    expect(state.channels[0]).not.toHaveProperty("secret");
    expect(state.recipients[0]).toMatchObject({
      platformDepartmentIds: ["department-7"],
      memberIds: ["u-1", "u-2"],
      memberCount: 2,
    });
    expect(state.rules[0]).toMatchObject({ templateName: "设备告警", severity: "critical" });
    expect(state.deliveries[0]).toMatchObject({ channelName: "运维告警群", recipientName: "夜班组", retryable: true });
  });
});
