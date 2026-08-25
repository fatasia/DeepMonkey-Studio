import { describe, expect, it, vi } from "vitest";
import type { AuthStore } from "./serverClient.js";
import { normalizeServerBaseUrl, ServerProfileController, verifyServerProfile, type NamedServerProfile, type ServerProfileStore } from "./serverProfile.js";

const emptyAuthStore: AuthStore = {
  getAccessToken: () => undefined,
  setAccessToken: () => undefined,
  clearAccessToken: () => undefined
};

describe("server profiles", () => {
  it.each([
    [" http://192.168.1.10:4100/path ", "http://192.168.1.10:4100"],
    ["https://studio.example.test/", "https://studio.example.test"]
  ])("normalizes %s", (input, expected) => {
    expect(normalizeServerBaseUrl(input)).toBe(expected);
  });

  it.each(["", "localhost:4100", "ftp://example.test", "https://user:secret@example.test", "https://example.test?q=1"])
    ("rejects unsafe server address %j", (input) => {
      expect(() => normalizeServerBaseUrl(input)).toThrow();
    });

  it("pins the first successful handshake to the stable server instance ID", async () => {
    const result = await verifyServerProfile(profile(), emptyAuthStore, async () => response({
      serverInstanceId: "server-1",
      apiVersion: "1.0",
      serverTime: "2026-08-25T12:00:00.000Z",
      capabilities: {
        applications: { schemaVersions: [2], immutablePublications: true },
        legacyScenes: { schemaVersions: [1], routes: true },
        authentication: { providers: ["local"] },
        hosts: { browser: true, tauri: false }
      }
    }));

    expect(result.status).toBe("connected");
    if (result.status === "connected") expect(result.profile.expectedServerInstanceId).toBe("server-1");
  });

  it("detects an IP that now points to another server instance", async () => {
    const result = await verifyServerProfile(
      { ...profile(), expectedServerInstanceId: "server-1" },
      emptyAuthStore,
      async () => response({
        serverInstanceId: "server-2",
        apiVersion: "1.0",
        serverTime: "2026-08-25T12:00:00.000Z",
        capabilities: {
          applications: { schemaVersions: [2], immutablePublications: true },
          legacyScenes: { schemaVersions: [1], routes: true },
          authentication: { providers: ["local"] },
          hosts: { browser: true, tauri: false }
        }
      })
    );

    expect(result).toEqual(expect.objectContaining({ status: "instance-mismatch", expectedServerInstanceId: "server-1" }));
  });

  it("hydrates, persists and clears one active profile", async () => {
    let stored: NamedServerProfile | undefined = profile();
    const store: ServerProfileStore = {
      load: vi.fn(() => stored),
      save: vi.fn((value) => { stored = value; }),
      clear: vi.fn(() => { stored = undefined; })
    };
    const controller = new ServerProfileController(store);

    await expect(controller.hydrate()).resolves.toEqual(profile());
    await expect(controller.apply({ ...profile(), baseUrl: "https://new.example.test/path" }))
      .resolves.toEqual({ ...profile(), baseUrl: "https://new.example.test" });
    await controller.clear();
    expect(() => controller.requireCurrent()).toThrow("尚未配置服务器");
  });
});

function profile(): NamedServerProfile {
  return { id: "primary", name: "主服务器", baseUrl: "https://studio.example.test" };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
