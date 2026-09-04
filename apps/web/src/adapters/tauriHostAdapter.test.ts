import { describe, expect, it, vi } from "vitest";
import type { NamedServerProfile } from "@bim-studio/server-sdk";
import { isTauriRuntime, TauriHostAdapter, type TauriInvoke } from "./tauriHostAdapter.js";

describe("TauriHostAdapter", () => {
  it("hydrates and persists the single server profile through restricted commands", async () => {
    let stored: NamedServerProfile | undefined = profile();
    let storedToken: string | undefined;
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === "get_server_profile") return stored as T;
      if (command === "get_auth_token") return storedToken as T;
      if (command === "set_server_profile") {
        stored = args?.profile as NamedServerProfile;
        return stored as T;
      }
      if (command === "clear_server_profile") {
        stored = undefined;
        return undefined as T;
      }
      if (command === "clear_auth_token") {
        storedToken = undefined;
        return undefined as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const adapter = new TauriHostAdapter(createWindow(), invoke);

    await expect(adapter.hydrateServerProfile()).resolves.toEqual(profile());
    await expect(adapter.saveServerProfile({ ...profile(), baseUrl: "https://new.example.test" }))
      .resolves.toEqual({ ...profile(), baseUrl: "https://new.example.test" });
    await adapter.clearServerProfile();
    expect(() => adapter.getServerProfile()).toThrow("尚未配置服务器");
  });

  it("restores remembered desktop login tokens and clears them on unauthorized", async () => {
    const browserWindow = createWindow();
    let storedToken: string | undefined = "remembered-token";
    const invoke: TauriInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === "get_server_profile") return profile() as T;
      if (command === "get_auth_token") return storedToken as T;
      if (command === "set_auth_token") storedToken = String(args?.token);
      if (command === "clear_auth_token") storedToken = undefined;
      return undefined as T;
    };
    const adapter = new TauriHostAdapter(browserWindow, invoke);
    const listener = vi.fn();
    browserWindow.addEventListener("bim-studio-auth-required", listener);

    await adapter.hydrateServerProfile();
    expect(adapter.getAccessToken()).toBe("remembered-token");
    adapter.setAccessToken("token-1", true);
    expect(adapter.getAccessToken()).toBe("token-1");
    adapter.notifyUnauthorized();
    await Promise.resolve();

    expect(adapter.getAccessToken()).toBe("");
    expect(storedToken).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("detects the Tauri runtime marker without relying on user agent", () => {
    const browserWindow = createWindow() as Window & { __TAURI_INTERNALS__?: unknown };
    expect(isTauriRuntime(browserWindow)).toBe(false);
    browserWindow.__TAURI_INTERNALS__ = {};
    expect(isTauriRuntime(browserWindow)).toBe(true);
  });
});

function profile(): NamedServerProfile {
  return { id: "primary", name: "主服务器", baseUrl: "https://studio.example.test" };
}

function createWindow(): Window {
  return new EventTarget() as unknown as Window;
}
