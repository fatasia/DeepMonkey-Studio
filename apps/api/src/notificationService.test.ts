import { describe, expect, it, vi } from "vitest";
import { NotificationService } from "./notificationService.js";
import { NotificationTransportError } from "./notificationTransportError.js";

const event = { id: "event-1", type: "scene.published", severity: "warning" as const, title: "产线发布", body: "发布完成", occurredAt: "2026-08-31T00:00:00.000Z", target: { projectId: "project-1", sceneId: "scene-1" } };

describe("NotificationService", () => {
  it("expands groups uniquely, renders templates, retries, and audits delivery", async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new NotificationTransportError("temporary", true)).mockResolvedValue(undefined);
    const service = new NotificationService({
      channels: [{ id: "webhook", kind: "webhook", name: "集成", endpoint: "https://notify.example.test", enabled: true }],
      recipients: [{ id: "operator", kind: "person", name: "值班员", address: "ops@example.test" }, { id: "team", kind: "group", name: "生产组", memberIds: ["operator"] }],
      templates: [{ id: "published", format: "markdown", title: "{title}", body: "{body} · {severity}" }],
      rules: [{ id: "publish", eventType: "scene.published", severities: ["warning"], target: { projectId: "project-1" }, recipientIds: ["operator", "team"], channelIds: ["webhook"], templateId: "published", dedupeWindowSeconds: 60 }],
      transport: { deliver },
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      sleep: async () => undefined,
    });
    const first = await service.dispatch(event);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ title: "产线发布", body: "发布完成 · warning", recipients: [expect.objectContaining({ id: "operator" })] }));
    expect(first).toEqual([expect.objectContaining({ status: "delivered", attempts: 2, recipientId: "operator" })]);
    expect(await service.dispatch({ ...event, id: "event-2" })).toEqual([expect.objectContaining({ status: "suppressed", reason: "deduplicated" })]);
    expect(service.listAudit()).toHaveLength(2);
  });

  it("honors quiet hours and delivery rate limits without sending", async () => {
    const deliver = vi.fn();
    const service = new NotificationService({
      channels: [{ id: "mail", kind: "smtp", name: "邮箱", enabled: true }],
      recipients: [{ id: "operator", kind: "person", name: "值班员", address: "ops@example.test" }],
      templates: [{ id: "alert", format: "text", title: "{title}", body: "{body}" }],
      rules: [{ id: "alert", eventType: "alarm.raised", severities: ["critical"], recipientIds: ["operator"], channelIds: ["mail"], templateId: "alert", quietHours: { startHour: 0, endHour: 8 } }],
      transport: { deliver }, now: () => new Date("2026-08-31T03:00:00.000Z"),
    });
    const result = await service.dispatch({ ...event, type: "alarm.raised", severity: "critical" });
    expect(result[0]).toMatchObject({ status: "suppressed", reason: "quiet_hours" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("limits a rule after its configured hourly delivery budget", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new NotificationService({
      channels: [{ id: "mail", kind: "smtp", name: "邮箱", enabled: true }],
      recipients: [{ id: "operator", kind: "person", name: "值班员", address: "ops@example.test" }],
      templates: [{ id: "alert", format: "text", title: "{title}", body: "{body}" }],
      rules: [{ id: "alert", eventType: "alarm.raised", severities: ["critical"], recipientIds: ["operator"], channelIds: ["mail"], templateId: "alert", maxDeliveriesPerHour: 1 }],
      transport: { deliver }, now: () => new Date("2026-08-31T12:00:00.000Z"),
    });

    await service.dispatch({ ...event, type: "alarm.raised", severity: "critical", id: "alarm-1" });
    const limited = await service.dispatch({ ...event, type: "alarm.raised", severity: "critical", id: "alarm-2", title: "另一条告警" });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(limited).toEqual([expect.objectContaining({ status: "suppressed", reason: "rate_limited" })]);
  });

  it("expands nested members and keeps department targets in one application batch", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const service = new NotificationService({
      channels: [{ id: "wecom", kind: "wecom", name: "企微", enabled: true, deliveryMode: "application" }],
      recipients: [
        { id: "person", kind: "person", name: "值班员", platformUserId: "user-1" },
        { id: "department", kind: "group", name: "维修部", platformDepartmentIds: ["12"], memberIds: ["person"] },
        { id: "team", kind: "group", name: "生产组", memberIds: ["department", "person"] },
      ],
      templates: [{ id: "alert", format: "card-lite", title: "{title}", body: "{body}" }],
      rules: [{ id: "alert", eventType: "alarm.raised", severities: ["critical"], recipientIds: ["team"], channelIds: ["wecom"], templateId: "alert" }],
      transport: { deliver },
    });

    await service.dispatch({ ...event, type: "alarm.raised", severity: "critical" });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ recipients: expect.arrayContaining([expect.objectContaining({ id: "person" }), expect.objectContaining({ id: "department" })]) }));
  });
});
