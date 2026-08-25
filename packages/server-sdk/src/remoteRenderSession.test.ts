import { describe, expect, it } from "vitest";
import { RemoteRenderSession } from "./remoteRenderSession.js";

describe("RemoteRenderSession", () => {
  it("models allocation, signaling, streaming, degradation and clean close", () => {
    const session = createSession();

    expect(session.dispatch({ type: "allocate" }).state).toBe("allocating");
    expect(session.dispatch({ type: "allocated" }).state).toBe("signaling");
    expect(session.dispatch({ type: "connected" }).state).toBe("streaming");
    expect(session.dispatch({ type: "latency", roundTripLatencyMs: 180, degradedAboveMs: 150 }).state).toBe("degraded");
    expect(session.dispatch({ type: "recover" }).state).toBe("signaling");
    expect(session.dispatch({ type: "connected" }).state).toBe("streaming");
    expect(session.dispatch({ type: "close" }).state).toBe("closing");
    expect(session.dispatch({ type: "closed" }).state).toBe("closed");
  });

  it("keeps the local renderer fallback in a failed session", () => {
    const session = createSession();
    session.dispatch({ type: "allocate" });

    expect(session.dispatch({ type: "fail", code: "gpu-capacity" })).toEqual(expect.objectContaining({
      state: "failed",
      failureCode: "gpu-capacity",
      fallback: "local-webgpu"
    }));
  });

  it("rejects invalid transitions instead of hiding protocol errors", () => {
    const session = createSession();
    expect(() => session.dispatch({ type: "connected" })).toThrow("不能从 idle");
    expect(() => session.dispatch({ type: "latency", roundTripLatencyMs: -1, degradedAboveMs: 150 })).toThrow("不能从 idle");
  });
});

function createSession(): RemoteRenderSession {
  return new RemoteRenderSession({
    sessionId: "session-1",
    userId: "user-1",
    projectId: "project-1",
    publicationId: "publication-1"
  }, "local-webgpu");
}
