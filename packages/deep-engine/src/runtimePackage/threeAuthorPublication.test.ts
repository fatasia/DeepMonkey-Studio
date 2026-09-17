import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { ThreeProjectionBridge } from "../threeBridge/ThreeProjectionBridge.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, serializeDeepRuntimePackage } from "./index.js";
import { materializeRuntimeRenderPacket } from "./renderPacket.js";

function bridge(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
    objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
    objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender,
    materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });
}

describe("Three author publication", () => {
  it("publishes Float64 mirrored premultiplied glass without an adapter copy", () => {
    const material = new THREE.MeshStandardMaterial({ color: "#653219", transparent: true,
      opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
    material.premultipliedAlpha = true;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material); mesh.scale.x = -1;
    mesh.updateWorldMatrix(true, true);
    const projected = bridge().project(mesh, { cameraLayerMask: 1 });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.packet.instances[0]!.transform).toBeInstanceOf(Float64Array);
    const sourceTransform = projected.packet.instances[0]!.transform;
    const runtime = buildDeepRuntimePackage({ packageId: "three.author.glass", packageVersion: "1.0.0",
      renderPacket: { id: "scene.main", revision: 1, value: projected.packet } });
    const parsed = parseDeepRuntimePackage(serializeDeepRuntimePackage(runtime));
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    const packet = materializeRuntimeRenderPacket(parsed.value.payloads[parsed.value.entrypoints.renderPacket], "$.scene.main");
    const batch = prepareRenderPacket(packet).batches[0]!;
    expect(batch).toMatchObject({ doubleSided: true, premultipliedAlpha: true, mirrored: false });
    expect(batch.data[31]! & (1 + 4 + 128)).toBe(1 + 4 + 128);
    expect(packet.instances[0]!.transform[0]).toBe(-1);
    expect(projected.packet.instances[0]!.transform).toBe(sourceTransform);
    expect(projected.packet.instances[0]!.transform).toBeInstanceOf(Float64Array);
  });
});
