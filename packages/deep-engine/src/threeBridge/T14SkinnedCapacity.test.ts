import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { deformationBridge } from "./deformation.testUtils.js";

describe("T14 editor skinning capacity", () => {
  it("projects and identifies 512 independently posed 64-joint actors beyond the static tree limit", () => {
    const actors = 512, jointsPerActor = 64;
    const geometry = new THREE.PlaneGeometry(1, 1, 7, 7);
    const count = geometry.attributes.position!.count;
    const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex++) {
      indices[vertex * 4] = vertex; weights[vertex * 4] = 1;
    }
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(indices, 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
    const root = new THREE.Group(), material = new THREE.MeshStandardMaterial();
    const meshes: THREE.SkinnedMesh[] = [];
    for (let actor = 0; actor < actors; actor++) {
      const mesh = new THREE.SkinnedMesh(geometry, material), bones: THREE.Bone[] = [];
      for (let joint = 0; joint < jointsPerActor; joint++) {
        const bone = new THREE.Bone();
        if (joint) bones[joint - 1]!.add(bone);
        bones.push(bone);
      }
      mesh.add(bones[0]!); mesh.bind(new THREE.Skeleton(bones)); root.add(mesh); meshes.push(mesh);
    }
    root.updateWorldMatrix(true, true);
    const bridge = deformationBridge(), first = bridge.project(root, { cameraLayerMask: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.packet.instances).toHaveLength(actors);
    expect(first.packet.deformation?.poses).toHaveLength(actors);
    expect(first.packet.deformation?.sources).toHaveLength(1);
    expect(first.acknowledge()).toBe(true);
    expect(bridge.sourceForInstanceId(first.packet.instances[actors - 1]!.id)).toBe(meshes[actors - 1]);
    meshes[actors - 1]!.skeleton.bones[jointsPerActor - 1]!.position.x = 3;
    root.updateWorldMatrix(true, true);
    const changed = bridge.project(root, { cameraLayerMask: 1 });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.packet.deformation?.poses[actors - 1]!.palette!.matrices[(jointsPerActor - 1) * 16 + 12]).toBe(3);
    expect(changed.packet.deformation?.poses[0]).toBe(first.packet.deformation?.poses[0]);
  });
});
