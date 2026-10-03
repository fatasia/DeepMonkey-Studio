import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { StudioDeepOutlineSync, type OutlineSyncTarget } from "./studioDeepOutlineSync";
import { deepOutlineSnapshot, syncDeepOutlineTags } from "./deepOutlineTags";

type Result = Awaited<ReturnType<OutlineSyncTarget["setOutlinedModels"]>>;
function fixture(result: Result = "updated") {
  const owner = {}, pump = new THREE.Group(), pipe = new THREE.Group(), child = new THREE.Mesh();
  pump.add(child);
  const host = { listModels: () => [{ id: "pump", object: pump }, { id: "pipe", object: pipe }],
    getDeepOutlinedObjects: () => deepOutlineSnapshot(owner) };
  const target = { setOutlinedModels: vi.fn<OutlineSyncTarget["setOutlinedModels"]>(async () => result) };
  return { owner, pump, pipe, child, host, target, applied: vi.fn(), sync: new StudioDeepOutlineSync() };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("independent-packet outline sync", () => {
  it("leaves compiled outline bits alone until the host has ever set an outline set", () => {
    const f = fixture();
    expect(deepOutlineSnapshot(f.owner).revision).toBe(0);
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(false);
    expect(f.target.setOutlinedModels).not.toHaveBeenCalled();
  });

  it("resolves tagged objects (model roots and inner nodes) to author model ids, dispatches once per revision and repaints on completion", async () => {
    const f = fixture();
    syncDeepOutlineTags(f.owner, [f.child, f.pipe]);
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(true);
    expect(f.target.setOutlinedModels).toHaveBeenCalledWith(new Set(["pump", "pipe"]));
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(false);
    await flush();
    expect(f.applied).toHaveBeenCalledTimes(1);
    syncDeepOutlineTags(f.owner, []);
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(true);
    expect(f.target.setOutlinedModels).toHaveBeenLastCalledWith(new Set());
    expect(f.target.setOutlinedModels).toHaveBeenCalledTimes(2);
  });

  it("does not repaint on unchanged and stops asking an unsupported backend", async () => {
    const unchanged = fixture("unchanged");
    syncDeepOutlineTags(unchanged.owner, [unchanged.pipe]);
    unchanged.sync.apply(unchanged.target, unchanged.host, unchanged.applied);
    await flush();
    expect(unchanged.applied).not.toHaveBeenCalled();
    const unsupported = fixture("unsupported");
    syncDeepOutlineTags(unsupported.owner, [unsupported.pump]);
    unsupported.sync.apply(unsupported.target, unsupported.host, unsupported.applied);
    await flush();
    syncDeepOutlineTags(unsupported.owner, []);
    expect(unsupported.sync.apply(unsupported.target, unsupported.host, unsupported.applied)).toBe(false);
    expect(unsupported.target.setOutlinedModels).toHaveBeenCalledTimes(1);
  });

  it("retries once after a failed update and then gives up instead of looping every frame", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.target.setOutlinedModels.mockRejectedValue(new Error("stage failed"));
    syncDeepOutlineTags(f.owner, [f.pipe]);
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(true);
    await flush();
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(true);
    await flush();
    expect(f.sync.apply(f.target, f.host, f.applied)).toBe(false);
    expect(f.target.setOutlinedModels).toHaveBeenCalledTimes(2);
    expect(f.applied).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores hosts without the snapshot accessor (legacy fixtures)", () => {
    const f = fixture();
    expect(f.sync.apply(f.target, { listModels: f.host.listModels })).toBe(false);
  });
});
