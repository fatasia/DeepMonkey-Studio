import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngine } from "./ViewerEngine";

const update = (ViewerEngine.prototype as unknown as { updateCollisions(force: boolean, now: number): void }).updateCollisions;

describe("idle collision updates", () => {
  it("does not traverse models when no collision checks or stale highlights exist", () => {
    const values = vi.fn(() => { throw new Error("idle traversal"); });
    update.call({ collisionEnabledIds: new Set(), collidingIds: new Set(), collisionRecords: [], models: { values } } as never, true, 1_000);
    expect(values).not.toHaveBeenCalled();
  });

  it("still clears the previous highlight after collision checks are disabled", () => {
    const model = { id: "device", visible: true, object: new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()) };
    const setCollisionHighlight = vi.fn(), onCollisionChange = vi.fn();
    const state = { collisionEnabledIds:new Set(),collidingIds:new Set(["device"]),collisionRecords:[{id:"old"}],
      models:new Map([["device",model]]),lastCollisionCheck:0,setCollisionHighlight,onCollisionChange };
    update.call(state as never,true,1_000);
    expect(setCollisionHighlight).toHaveBeenCalledWith(model,false);
    expect(state.collidingIds.size).toBe(0); expect(state.collisionRecords).toEqual([]);
    expect(onCollisionChange).toHaveBeenCalledOnce();
  });
});
