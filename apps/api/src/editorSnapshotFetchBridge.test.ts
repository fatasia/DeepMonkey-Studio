import { describe, expect, it } from "vitest";
import { EditorSnapshotFetchBridge } from "./editorSnapshotFetchBridge.js";
import type { EditorPresenceRegistry } from "./editorPresence.js";
import type { SystemUserRecord } from "@bim-studio/contracts";

const user: SystemUserRecord = { id: "u1", username: "owner", role: "admin", projectIds: ["p1"] } as SystemUserRecord;

function registryWith(sessionId: string, leaseId: string): EditorPresenceRegistry {
  return {
    readOwned: (u: SystemUserRecord, id: string) => id === sessionId && u.id === "u1"
      ? { sessionId, leaseId, surface: "scene", targetId: "scene-1", projectId: "p1" }
      : undefined,
  } as unknown as EditorPresenceRegistry;
}

const okPayload = { status: "ok", resourceId: "present-color", frameId: "frame-9", format: "rgba16float",
  width: 4, height: 2, byteLength: 64, dataBase64: "QUJD" };

describe("editor snapshot fetch bridge", () => {
  it("round-trips a fetch through pending, lease-matched driver, and idempotent cache", async () => {
    const bridge = new EditorSnapshotFetchBridge(registryWith("s1", "lease-1"));
    const pending = bridge.request(user, "s1", { requestId: "r1", resourceId: "present-color", frameId: "frame-9" });
    expect(bridge.takeDriverRequest("s1", "lease-1")).toMatchObject({ requestId: "r1", resourceId: "present-color" });
    expect(bridge.takeDriverRequest("s1", "wrong-lease")).toBeUndefined();
    expect(bridge.submitDriverResult("s1", "r1", okPayload)).toBe(true);
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.byteLength).toBe(64);
    await expect(bridge.request(user, "s1", { requestId: "r1", resourceId: "present-color" })).resolves.toMatchObject({ status: "ok" });
  });

  it("rejects viewers, malformed input, and over-budget payloads fail-closed", async () => {
    const bridge = new EditorSnapshotFetchBridge(registryWith("s1", "lease-1"));
    const viewer = { ...user, role: "viewer" } as SystemUserRecord;
    await expect(bridge.request(viewer, "s1", { requestId: "r2", resourceId: "present-color" }))
      .resolves.toMatchObject({ status: "unavailable", message: "viewer 角色无诊断快照读取权限" });
    await expect(bridge.request(user, "s1", { requestId: "r3", resourceId: "made-up" }))
      .resolves.toMatchObject({ status: "unavailable" });
    // 发起（挂起）→ 超预算回传 → 再等待结果；request 不先 await，否则死锁。
    const pending = bridge.request(user, "s1", { requestId: "r4", resourceId: "linear-depth" });
    expect(bridge.submitDriverResult("s1", "r4", { status: "ok", resourceId: "linear-depth",
      frameId: "f", format: "r32float", width: 1, height: 1, byteLength: 1,
      dataBase64: "x".repeat(17 * 1024 * 1024) })).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "unavailable", message: "回传载荷不合法或超出预算" });
  });

  it("supersedes an older pending request and caches its unavailable outcome", async () => {
    const bridge = new EditorSnapshotFetchBridge(registryWith("s1", "lease-1"));
    const first = bridge.request(user, "s1", { requestId: "a", resourceId: "opaque-hdr" });
    const second = bridge.request(user, "s1", { requestId: "b", resourceId: "present-color" });
    await expect(first).resolves.toMatchObject({ status: "unavailable", message: "被更新的拉取请求取代" });
    expect(bridge.takeDriverRequest("s1", "lease-1")).toMatchObject({ requestId: "b" });
    expect(bridge.submitDriverResult("s1", "b", okPayload)).toBe(true);
    await expect(second).resolves.toMatchObject({ status: "ok" });
  });
});
