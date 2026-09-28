import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { authorPoseLod } from "./authorPoseLod.js";
import { deformationBridge, skinMesh } from "./deformation.testUtils.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";
import { runtime, view } from "./DeepWebGpuBackend.testUtils.js";

const camera = { ...view, eye: [0, 0, 0] as const, target: [0, 0, -1] as const,
  up: [0, 1, 0] as const, verticalFovRadians: Math.PI / 3, width: 1920, height: 1080 };

function actor(z: number) {
  const mesh = skinMesh(new THREE.PlaneGeometry(1, 1));
  mesh.position.z = z;
  mesh.updateWorldMatrix(true, true);
  mesh.geometry.computeBoundingSphere();
  mesh.userData.deepPoseBoundRadius = 2;
  return mesh;
}

function pose(result: Awaited<ReturnType<DeepWebGpuBackend["sync"]>>) {
  if (result.status !== "committed") throw new Error("Expected committed pose.");
  return result.packet.deformation!.poses[0]!;
}

describe("T14 author pose LOD", () => {
  it("keeps near, large-on-screen and critical actors precise; fails open without valid bounds", () => {
    const near = actor(-10), far = actor(-160);
    expect(authorPoseLod(near, camera)).toBe("precise");
    expect(authorPoseLod(far, camera)).toBe("distant");
    far.position.x = 500; far.updateWorldMatrix(true, true);
    expect(authorPoseLod(far, camera)).toBe("outside");
    far.userData.deepPoseCritical = true;
    expect(authorPoseLod(far, camera)).toBe("precise");
    far.userData.deepPoseCritical = false;
    expect(authorPoseLod(far, { ...camera, eye: [NaN, 0, 0] })).toBe("precise");
    delete far.userData.deepPoseBoundRadius;
    expect(authorPoseLod(far, camera)).toBe("precise");
    far.userData.deepPoseBoundRadius = -1;
    expect(authorPoseLod(far, camera)).toBe("precise");
    far.userData.deepPoseBoundRadius = 2;
    far.scale.setScalar(100); far.updateWorldMatrix(true, true);
    expect(authorPoseLod(far, camera)).toBe("precise");
    far.scale.setScalar(1); far.updateWorldMatrix(true, true);
    expect(authorPoseLod(far, { ...camera, up: undefined })).toBe("outside");
    expect(authorPoseLod(far, { ...camera, verticalFovRadians: undefined })).toBe("precise");
  });

  it("samples distant cadence without throttling root transforms, preserves IDs, and refreshes on camera approach", async () => {
    const mesh = actor(-160), projection = deformationBridge(), gpu = runtime(), backend = new DeepWebGpuBackend(gpu, projection);
    const first = pose(await backend.sync(mesh, 1, undefined, camera));
    const instanceId = gpu.packets[0]!.instances[0]!.id;
    for (let frame = 1; frame < 8; frame++) {
      mesh.skeleton.bones[1]!.position.x = frame;
      mesh.updateWorldMatrix(true, true);
      const result = await backend.sync(mesh, 1, undefined, camera);
      expect(pose(result)).toBe(first);
      if (result.status === "committed") expect(result.packet.instances[0]!.id).toBe(instanceId);
      expect(projection.sourceForInstanceId(instanceId)).toBe(mesh);
    }
    mesh.position.x = 7; mesh.updateWorldMatrix(true, true);
    const moving = await backend.sync(mesh, 1, undefined, camera);
    if (moving.status !== "committed") throw new Error("Expected moving actor to commit.");
    expect(moving.packet.instances[0]!.transform[12]).toBe(7);
    const fresh = pose(moving);
    expect(fresh).not.toBe(first);
    mesh.skeleton.bones[1]!.position.x = 9; mesh.updateWorldMatrix(true, true);
    const approachingCamera = { ...camera, eye: [0, 0, -155] as const, target: [0, 0, -160] as const };
    const near = pose(await backend.sync(mesh, 1, undefined, approachingCamera));
    expect(near).not.toBe(fresh);
    expect(projection.sourceForInstanceId(instanceId)).toBe(mesh);
  });

  it("does not consume the cadence on rejected GPU submission and keeps an outside actor resumable", async () => {
    const mesh = actor(-160), gpu = runtime(), backend = new DeepWebGpuBackend(gpu, deformationBridge());
    const first = pose(await backend.sync(mesh, 1, undefined, camera));
    mesh.position.x = 500; mesh.updateWorldMatrix(true, true);
    const outside = { ...camera, eye: [0, 0, 0] as const };
    const entered = pose(await backend.sync(mesh, 1, undefined, outside));
    expect(entered).not.toBe(first);
    for (let frame = 0; frame < 32; frame++) {
      mesh.skeleton.bones[1]!.position.x = frame;
      mesh.updateWorldMatrix(true, true);
      const current = pose(await backend.sync(mesh, 1, undefined, outside));
      if (frame < 31) expect(current).toBe(entered);
    }
    gpu.updateInstances = vi.fn(() => { throw new Error("GPU upload failed"); });
    mesh.skeleton.bones[1]!.position.x = 77;
    mesh.updateWorldMatrix(true, true);
    mesh.position.x = 501; mesh.updateWorldMatrix(true, true);
    await expect(backend.sync(mesh, 1, undefined, outside)).rejects.toThrow("GPU upload failed");
    gpu.updateInstances = vi.fn();
    const retried = pose(await backend.sync(mesh, 1, undefined, outside));
    expect(retried).not.toBe(entered);
    mesh.position.x = 0; mesh.updateWorldMatrix(true, true);
    const resumed = pose(await backend.sync(mesh, 1, undefined, camera));
    expect(resumed).not.toBe(retried);
  });
});
