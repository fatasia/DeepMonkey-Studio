import { describe, expect, it } from "vitest";
import { sceneDataWebSocketUrl } from "./sceneDataSocket";

describe("scene data WebSocket URL", () => {
  it("uses the configured HTTP server instead of the browser host", () => {
    expect(sceneDataWebSocketUrl("http://127.0.0.1:15469", "local/project"))
      .toBe("ws://127.0.0.1:15469/api/projects/local%2Fproject/data/ws");
  });

  it("uses the server origin and upgrades HTTPS to WSS", () => {
    expect(sceneDataWebSocketUrl("https://studio.example.test/base", "cloud"))
      .toBe("wss://studio.example.test/api/projects/cloud/data/ws");
  });
});
