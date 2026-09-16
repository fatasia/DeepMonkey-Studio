import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { accepted, bridge, project } from "./testFixture.js";
import { deformationBridge, morphMesh, skinMesh } from "./deformation.testUtils.js";

describe("Three author deformation projection", () => {
  it("keeps unsupported as the default capability", () => {
    expect(bridge().project(morphMesh(), { cameraLayerMask: 1 }).ok).toBe(false);
    expect(bridge().project(skinMesh(), { cameraLayerMask: 1 }).ok).toBe(false);
  });

  it("shares immutable sources while isolating poses and preserving paused revisions", () => {
    const a = morphMesh(), b = new THREE.Mesh(a.geometry, a.material), root = new THREE.Group(); root.add(a, b);
    a.morphTargetInfluences![0] = 0.25; b.morphTargetInfluences![0] = -0.5;
    const target = deformationBridge(), first = project(target, root);
    const d = first.packet.deformation!;
    expect(d.sources).toHaveLength(1); expect(d.poses).toHaveLength(2);
    expect(new Set(first.packet.instances.map(i => i.pose)).size).toBe(2);
    expect(prepareRenderPacket(first.packet).batches).toHaveLength(2);
    expect(first.acknowledge()).toBe(true);
    const paused = project(target, root);
    expect(paused.update).toBe("instances"); expect(paused.packet.deformation!.poses).toEqual(d.poses);
    expect(paused.packet.deformation!.sources).toBe(d.sources); paused.acknowledge();
    a.morphTargetInfluences![0] = 0.8;
    const changed = project(target, root);
    expect(changed.update).toBe("instances");
    expect(changed.packet.deformation!.poses[0]!.revision).toBe(1);
    expect(changed.packet.deformation!.poses[1]).toBe(d.poses[1]);
    expect(d.poses[0]!.morphWeights!.values[0]).toBe(0.25);
  });

  it("invalidates source versions independently of geometry and preserves author arrays", () => {
    const author = morphMesh(), target = deformationBridge();
    const first = project(target, author); first.acknowledge();
    const attr = author.geometry.morphAttributes.position![0]!;
    const before = first.packet.deformation!.sources[0]!.morph!.primitive.targets[0]!.positionDeltas!.slice();
    attr.setZ(0, 7); attr.needsUpdate = true;
    const next = project(target, author);
    expect(next.update).toBe("full"); expect(next.packet.geometries[0]).toBe(first.packet.geometries[0]);
    expect(next.packet.deformation!.sources[0]!.revision).toBe(1);
    expect(first.packet.deformation!.sources[0]!.morph!.primitive.targets[0]!.positionDeltas).toEqual(before);
    expect(attr.getZ(0)).toBe(7);
    target.clear(); expect(project(target, author).update).toBe("full");
  });

  it("prepares newly visible pose identities without invalidating their shared static source", () => {
    const a = skinMesh(), b = skinMesh(a.geometry), root = new THREE.Group(); root.add(a, b);
    b.visible = false;
    const target = deformationBridge(), first = project(target, root); first.acknowledge();
    b.visible = true; b.skeleton.bones[1]!.position.y = 5;
    const added = project(target, root); expect(added.update).toBe("full");
    expect(added.packet.deformation!.sources[0]).toBe(first.packet.deformation!.sources[0]);
    expect(added.packet.deformation!.poses).toHaveLength(2);
    expect(added.packet.deformation!.poses[1]!.palette!.matrices[29]).toBe(5);
    expect(added.packet.deformation!.poses[0]!.palette!.matrices[29]).toBe(0);
    added.acknowledge(); root.remove(a);
    expect(project(target, root).update).toBe("full");
  });

  it("does not accept superseded pose snapshots", () => {
    const author = morphMesh(), target = deformationBridge();
    const first = project(target, author); first.acknowledge();
    author.morphTargetInfluences![0] = 0.2; const old = project(target, author);
    author.morphTargetInfluences![0] = 0.6; const next = project(target, author);
    expect(old.acknowledge()).toBe(false); expect(next.acknowledge()).toBe(true);
    expect(project(target, author).packet.deformation!.poses[0]).toBe(next.packet.deformation!.poses[0]);
  });

  it("reads current bones without skeleton.update and retains non-normalized weights", () => {
    const author = skinMesh(new THREE.PlaneGeometry(2, 2)), target = deformationBridge();
    const update = vi.spyOn(author.skeleton, "update");
    const first = project(target, author); first.acknowledge();
    expect(first.packet.deformation!.sources[0]!.skinning!.weightMode).toBe("preserve");
    expect(first.packet.deformation!.sources[0]!.skinning!.weights[0]).toBe(0.75);
    author.skeleton.bones[1]!.position.x = 4;
    const moved = project(target, author);
    expect(moved.update).toBe("instances");
    expect(moved.packet.deformation!.poses[0]!.palette!.matrices[28]).toBe(4);
    expect(update).not.toHaveBeenCalled(); expect(prepareRenderPacket(moved.packet).deformation).toBeDefined();
  });

  it("uses final normal-map vertex remapping for fused morph and skin streams", () => {
    const author = skinMesh(), geometry = author.geometry;
    geometry.setIndex([3, 1, 2]);
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    texture.needsUpdate = true; author.material.normalMap = texture;
    const result = project(deformationBridge(), author), source = result.packet.deformation!.sources[0]!;
    expect(source.kind).toBe("morph-skin");
    expect(source.skinning!.joints.filter((_, i) => i % 4 === 0)).toEqual(new Uint32Array([1, 1, 0]));
    expect(source.morph!.primitive.targets[0]!.positionDeltas!.filter((_, i) => i % 3 === 2)).toEqual(new Float32Array([4, 2, 3]));
    expect(source.morph!.tangents).toEqual(result.packet.geometries[0]!.tangents);
    expect(prepareRenderPacket(result.packet).deformation).toBeDefined();
  });

  it("projects skin-only normal maps with real tangents and no synthetic morph data", () => {
    const author = skinMesh(new THREE.PlaneGeometry(2, 2)); author.geometry.setIndex([3, 1, 2]);
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    texture.needsUpdate = true; author.material.normalMap = texture;
    const result = project(deformationBridge(), author), source = result.packet.deformation!.sources[0]!;
    expect(source.kind).toBe("skin"); expect(source.morph).toBeUndefined();
    expect(source.skinning!.tangents).toEqual(result.packet.geometries[0]!.tangents);
    expect(source.skinning!.joints.filter((_, i) => i % 4 === 0)).toEqual(new Uint32Array([1, 1, 0]));
    expect(prepareRenderPacket(result.packet).deformation).toBeDefined();
  });

  it("rejects zero skin weights and retries after correction without accepting failed state", () => {
    const author = skinMesh(), target = deformationBridge();
    const first = project(target, author); first.acknowledge();
    const weight = author.geometry.attributes.skinWeight!;
    weight.setX(0, 0); weight.needsUpdate = true;
    expect(target.project(author, { cameraLayerMask: 1 }).ok).toBe(false);
    weight.setX(0, 1); weight.needsUpdate = true;
    const fixed = accepted(target.project(author, { cameraLayerMask: 1 }));
    expect(fixed.update).toBe("full"); expect(fixed.packet.deformation!.sources[0]!.revision).toBe(1);
  });
});
