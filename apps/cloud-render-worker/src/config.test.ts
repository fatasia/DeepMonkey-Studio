import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

describe("cloud render worker config", () => {
  it("requires control token and public viewer origin", () => {
    expect(() => loadWorkerConfig({})).toThrow(/CLOUD_RENDER_WORKER_TOKEN/);
    expect(() => loadWorkerConfig({ CLOUD_RENDER_WORKER_TOKEN: "secret" })).toThrow(/PUBLIC_ORIGIN/);
  });

  it("parses TURN credentials without silently inventing fallback servers", () => {
    const value = loadWorkerConfig({
      CLOUD_RENDER_WORKER_TOKEN: "secret",
      CLOUD_RENDER_WORKER_PUBLIC_ORIGIN: "https://worker.example.test",
      CLOUD_RENDER_CHROMIUM_PATH: "C:\\chrome.exe",
      CLOUD_RENDER_ICE_SERVERS_JSON: '[{"urls":"turn:turn.example.test:3478","username":"cloud","credential":"secret"}]'
    });
    expect(value.iceServers).toEqual([{ urls: "turn:turn.example.test:3478", username: "cloud", credential: "secret" }]);
    expect(value.headless).toBe(false);
    expect(value.verifiedHardwareCodecs).toEqual([]);
  });

  it("accepts only an explicit operations-attested codec list", () => {
    const value = loadWorkerConfig({ CLOUD_RENDER_WORKER_TOKEN: "secret", CLOUD_RENDER_WORKER_PUBLIC_ORIGIN: "https://worker.example.test", CLOUD_RENDER_VERIFIED_HARDWARE_CODECS: "h264,av1" });
    expect(value.verifiedHardwareCodecs).toEqual(["h264", "av1"]);
    expect(() => loadWorkerConfig({ CLOUD_RENDER_WORKER_TOKEN: "secret", CLOUD_RENDER_WORKER_PUBLIC_ORIGIN: "https://worker.example.test", CLOUD_RENDER_VERIFIED_HARDWARE_CODECS: "vp9" })).toThrow(/仅支持/);
  });
});
