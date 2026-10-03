import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { StudioDeepOutlineSync, type OutlineSyncTarget } from "./studioDeepOutlineSync";
import { deepOutlineSnapshot, syncDeepOutlineTags } from "./deepOutlineTags";

function fixture() {
  const owner = {}, pump = new THREE.Group(), pipe = new THREE.Group(), child = new THREE.Mesh();
  pump.add(child);
  const host = { listModels: () => [{ id: "pump", object: pump }, { id: "pipe", object: pipe }],
    getDeepOutlinedObjects: () => deepOutlineSnapshot(owner) };
  const target = { setOutlinedModels: vi.fn<OutlineSyncTarget["setOutlinedModels"]>(() => "updated") };
  return { owner, pump, pipe, child, host, target, sync: new StudioDeepOutlineSync() };
}

describe("independent-packet outline sync", () => {
  it("leaves compiled outline bits alone until the host has ever set an outline set", () => {
    const f = fixture();
    expect(deepOutlineSnapshot(f.owner).revision).toBe(0);
    expect(f.sync.apply(f.target, f.host)).toBe(false);
    expect(f.target.setOutlinedModels).not.toHaveBeenCalled();
  });

  it("resolves tagged objects (model roots and inner nodes) to author model ids and applies once per revision", () => {
    const f = fixture();
    syncDeepOutlineTags(f.owner, [f.child, f.pipe]);
    expect(f.sync.apply(f.target, f.host)).toBe(true);
    expect(f.target.setOutlinedModels).toHaveBeenCalledWith(new Set(["pump", "pipe"]));
    expect(f.sync.apply(f.target, f.host)).toBe(false);
    expect(f.target.setOutlinedModels).toHaveBeenCalledTimes(1);
    syncDeepOutlineTags(f.owner, []);
    expect(f.sync.apply(f.target, f.host)).toBe(true);
    expect(f.target.setOutlinedModels).toHaveBeenLastCalledWith(new Set());
  });

  it("reports unchanged without requesting a repaint and stops asking an unsupported backend", () => {
    const f = fixture();
    f.target.setOutlinedModels.mockReturnValueOnce("unchanged");
    syncDeepOutlineTags(f.owner, [f.pipe]);
    expect(f.sync.apply(f.target, f.host)).toBe(false);
    f.target.setOutlinedModels.mockReturnValueOnce("unsupported");
    syncDeepOutlineTags(f.owner, [f.pump]);
    expect(f.sync.apply(f.target, f.host)).toBe(false);
    syncDeepOutlineTags(f.owner, []);
    expect(f.sync.apply(f.target, f.host)).toBe(false);
    expect(f.target.setOutlinedModels).toHaveBeenCalledTimes(2);
  });

  it("ignores hosts without the snapshot accessor (legacy fixtures)", () => {
    const f = fixture();
    expect(f.sync.apply(f.target, { listModels: f.host.listModels })).toBe(false);
  });
});
