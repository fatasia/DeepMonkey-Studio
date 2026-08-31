import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationConfigurationStore } from "./notificationConfigurationStore.js";
import { registerNotificationRoutes } from "./notificationRoutes.js";
import { NotificationService } from "./notificationService.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("notification configuration routes", () => {
  it("stores channel writes and returns a redacted snapshot", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-notification-routes-"));
    directories.push(dataDir);
    const configuration = new NotificationConfigurationStore(dataDir);
    await configuration.init();
    const service = new NotificationService({
      ...configuration.configuration(),
      transport: { deliver: async () => undefined },
    });
    const app = createApiServer();
    await registerNotificationRoutes(app, { configuration, service });

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/notifications/channels",
      payload: {
        id: "publish-hook", kind: "webhook", name: "发布集成", endpoint: "https://example.test/secret", secret: "secret", enabled: true,
      },
    });
    const snapshot = await app.inject({ method: "GET", url: "/api/admin/notifications/snapshot" });

    expect(created.statusCode).toBe(201);
    expect(snapshot.json().channels).toEqual([expect.objectContaining({ id: "publish-hook", endpointConfigured: true, secretConfigured: true })]);
    expect(snapshot.body).not.toContain("https://example.test/secret");
    expect(snapshot.body).not.toContain("\"secret\"");
    await app.close();
  });
});
