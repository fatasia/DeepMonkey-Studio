import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationConfigurationStore } from "./notificationConfigurationStore.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("NotificationConfigurationStore", () => {
  it("persists editable configuration while keeping Webhook endpoints and secrets out of snapshots", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-config-"));
    directories.push(dataDir);
    const store = new NotificationConfigurationStore(dataDir);
    await store.init();
    await store.putChannel({ id: "lark-ops", kind: "lark", name: "运维群", endpoint: "https://open.example.test/secret", secret: "signing-secret", enabled: true, deliveryMode: "bot" }, true);
    await store.put("recipients", { id: "ops", kind: "group", name: "运维组", mention: { all: true } }, true);
    await store.put("templates", { id: "alarm", format: "card-lite", title: "{title}", body: "{body}" }, true);
    await store.put("rules", { id: "alarm-rule", eventType: "alarm.raised", severities: ["critical"], recipientIds: ["ops"], channelIds: ["lark-ops"], templateId: "alarm" }, true);

    expect(store.snapshot().channels[0]).toMatchObject({ endpointConfigured: true, secretConfigured: true });
    expect(store.snapshot().channels[0]).not.toHaveProperty("endpoint");
    expect(store.snapshot().channels[0]).not.toHaveProperty("secretRef");
    expect(store.credential(store.configuration().channels[0].secretRef!)).toEqual({ kind: "webhook", signingSecret: "signing-secret" });
    await expect(store.remove("channels", "lark-ops")).rejects.toThrow("渠道仍被规则引用");
  });

  it("stores structured credentials only in the server credential collection", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-config-"));
    directories.push(dataDir);
    const store = new NotificationConfigurationStore(dataDir);
    await store.init();
    await store.putChannel({
      id: "wecom-app",
      kind: "wecom",
      name: "企业应用",
      enabled: true,
      deliveryMode: "application",
      credential: { kind: "wecom", corpId: "corp", corpSecret: "private-secret", agentId: 1001 },
    }, true);

    const channel = store.configuration().channels[0];
    expect(channel.secretRef).toBeTruthy();
    expect(channel).not.toHaveProperty("credential");
    expect(channel).not.toHaveProperty("secret");
    expect(store.credential(channel.secretRef!)).toEqual(expect.objectContaining({ corpSecret: "private-secret" }));

    const persisted = JSON.parse(await readFile(path.join(dataDir, "notification-configuration.json"), "utf8"));
    expect(persisted.channels[0]).not.toHaveProperty("credential");
    expect(persisted.channels[0]).not.toHaveProperty("secret");
  });

  it("rejects rules whose channel, recipient or template references are incomplete", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-config-"));
    directories.push(dataDir);
    const store = new NotificationConfigurationStore(dataDir);
    await store.init();

    await expect(store.put("rules", {
      id: "orphan-rule",
      eventType: "equipment.failure",
      severities: ["critical"],
      recipientIds: ["missing-recipient"],
      channelIds: ["missing-channel"],
      templateId: "missing-template",
    }, true)).rejects.toThrow("模板不存在");
  });
});
