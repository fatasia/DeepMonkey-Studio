import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServerNotificationRuntime } from "./notificationRuntime.js";

const directories: string[] = [];

afterEach(async () => Promise.all(
  directories.splice(0).map((item) => rm(item, { recursive: true, force: true })),
));

describe("createServerNotificationRuntime", () => {
  it("does not create dangling route references without a configured endpoint", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-runtime-"));
    directories.push(dataDir);

    const runtime = await createServerNotificationRuntime(dataDir, {});
    const snapshot = runtime.configuration.snapshot();

    expect(snapshot.channels).toEqual([]);
    expect(snapshot.recipients).toEqual([]);
    expect(snapshot.rules[0]).toMatchObject({ channelIds: [], recipientIds: [] });
  });

  it("wires the built-in route only when its endpoint exists", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-runtime-"));
    directories.push(dataDir);

    const runtime = await createServerNotificationRuntime(dataDir, {
      NOTIFICATION_WEBHOOK_URL: "https://example.test/hook",
    });
    const snapshot = runtime.configuration.snapshot();

    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.recipients).toHaveLength(1);
    expect(snapshot.rules[0]).toMatchObject({
      channelIds: ["publish-webhook"],
      recipientIds: ["publish-target"],
    });
  });
});
