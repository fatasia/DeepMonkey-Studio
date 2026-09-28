import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { captureAuthorSkinPalette, captureAuthorSkinPose } from "./authorSkinPose.js";
import { cpuSkinVertices, prepareSkinningInput, packJointPalette } from "../webgpu/gpuSkinningPacking.js";

function fixture() {
  const bone = new THREE.Bone();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([1, 2, 3], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([1, 1, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.add(bone); mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([bone]); mesh.bind(skeleton);
  bone.position.set(2, 0, 1); bone.scale.set(2, 3, 4); mesh.updateMatrixWorld(true);
  return { mesh, bone, skeleton };
}

describe("author skin pose snapshot", () => {
  it("reads current world matrices even with stale boneMatrices and never runs author callbacks", () => {
    const { mesh, skeleton } = fixture();
    skeleton.boneMatrices.fill(-99);
    const update = vi.spyOn(skeleton, "update").mockImplementation(() => { throw new Error("author side effect"); });
    const worldUpdate = vi.spyOn(mesh, "updateMatrixWorld");
    const pose = captureAuthorSkinPose(mesh, 3);
    const actual = new THREE.Vector3(1, 2, 3).applyMatrix4(new THREE.Matrix4().fromArray(pose.matrices));
    expect(actual.distanceTo(mesh.getVertexPosition(0, new THREE.Vector3()))).toBeLessThan(1e-6);
    expect(update).not.toHaveBeenCalled(); expect(worldUpdate).not.toHaveBeenCalled();
    expect([...skeleton.boneMatrices].every(value => value === -99)).toBe(true);
  });

  it("uses per-mesh bind matrices when objects share a skeleton", () => {
    const { mesh, skeleton } = fixture();
    const second = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
    second.skeleton = skeleton;
    second.bindMatrix.makeRotationZ(0.4); second.bindMatrixInverse.copy(second.bindMatrix).invert();
    const a = captureAuthorSkinPose(mesh, 0), b = captureAuthorSkinPose(second, 0);
    expect(a.matrices).not.toEqual(b.matrices);
    const projected = new THREE.Vector3(1, 2, 3).applyMatrix4(new THREE.Matrix4().fromArray(b.matrices));
    expect(projected.distanceTo(second.getVertexPosition(0, new THREE.Vector3()))).toBeLessThan(2e-6);
  });

  it("feeds the existing GPU packing contract with Three linear normal rows instead of inverse transpose", () => {
    const { mesh } = fixture(), pose = captureAuthorSkinPose(mesh, 1), palette = pose.copyPalette();
    expect(pose.normalRule).toBe("three-linear");
    const prepared = prepareSkinningInput({ revision: 0, positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([1, 1, 0]), joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) }, palette);
    const output = cpuSkinVertices(prepared);
    const expected = new THREE.Vector3(1, 1, 0).transformDirection(new THREE.Matrix4().fromArray(pose.matrices));
    expect(new THREE.Vector3(...output.slice(4, 7)).distanceTo(expected)).toBeLessThan(1e-6);
    const defaultPacked = packJointPalette({ revision: 1, matrices: palette.matrices });
    expect([...prepared.joints.slice(16)]).not.toEqual([...defaultPacked.slice(16)]);
  });

  it("owns frozen snapshots and fresh GPU arrays across author edits", () => {
    const { mesh, bone } = fixture(), before = captureAuthorSkinPose(mesh, 1);
    const saved = [...before.matrices], palette = before.copyPalette();
    palette.matrices.fill(0); palette.normalMatrices!.fill(0);
    expect(before.matrices).toEqual(saved);
    expect(before.copyPalette().matrices).toEqual(new Float32Array(saved));
    expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.matrices)).toBe(true);
    expect(Object.isFrozen(before.normalMatrices)).toBe(true);
    bone.position.x += 7; mesh.updateMatrixWorld(true);
    expect(captureAuthorSkinPose(mesh, 2).matrices).not.toEqual(saved);
    expect(before.matrices).toEqual(saved);
  });

  it("preserves inverse-bind order and weighted current Three bone transforms", () => {
    const { mesh, bone, skeleton } = fixture(), second = new THREE.Bone();
    second.position.set(-1, 4, 2); second.rotation.y = 0.7;
    mesh.add(second); mesh.updateMatrixWorld(true);
    skeleton.bones.push(second);
    skeleton.boneInverses[0] = new THREE.Matrix4().makeTranslation(-2, 1, 0);
    skeleton.boneInverses.push(new THREE.Matrix4().makeRotationX(-0.3));
    mesh.bindMatrix.makeTranslation(1, 3, -2); mesh.bindMatrixInverse.copy(mesh.bindMatrix).invert();
    mesh.geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 1, 0, 0], 4));
    mesh.geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([0.25, 0.75, 0, 0], 4));
    const pose = captureAuthorSkinPose(mesh, 0), projected = new THREE.Vector3();
    for (const [joint, weight] of [[0, 0.25], [1, 0.75]] as const) {
      const matrix = new THREE.Matrix4().fromArray(pose.matrices.slice(joint * 16, joint * 16 + 16));
      projected.addScaledVector(new THREE.Vector3(1, 2, 3).applyMatrix4(matrix), weight);
    }
    expect(projected.distanceTo(mesh.getVertexPosition(0, new THREE.Vector3()))).toBeLessThan(2e-6);
    // Three允许骨骼零缩放；显式线性normal rows不应触发逆转置求逆。
    bone.matrixWorld.makeScale(0, 2, 3);
    expect(() => packJointPalette(captureAuthorSkinPose(mesh, 1).copyPalette())).not.toThrow();
  });

  it("matches the CPU matrix reference across a 64-joint non-identity bind pose", () => {
    const { mesh, skeleton } = fixture();
    for (let joint = 1; joint < 64; joint++) {
      const bone = new THREE.Bone();
      bone.position.set(joint * 0.03, -joint * 0.02, joint * 0.01);
      bone.rotation.set(joint * 0.002, joint * -0.003, joint * 0.004);
      bone.scale.set(1 + joint * 0.001, 1 - joint * 0.0005, 1 + joint * 0.0003);
      mesh.add(bone); skeleton.bones.push(bone);
      skeleton.boneInverses.push(new THREE.Matrix4().makeRotationY(joint * 0.005));
    }
    mesh.bindMatrix.makeRotationZ(0.31).setPosition(2, -1, 0.5);
    mesh.bindMatrixInverse.copy(mesh.bindMatrix).invert();
    mesh.updateWorldMatrix(true, true);
    const pose = captureAuthorSkinPose(mesh, 0);
    let largestError = 0;
    for (let joint = 0; joint < 64; joint++) {
      const expected = new THREE.Matrix4().multiplyMatrices(
        mesh.bindMatrixInverse,
        new THREE.Matrix4().multiplyMatrices(skeleton.bones[joint]!.matrixWorld,
          new THREE.Matrix4().multiplyMatrices(skeleton.boneInverses[joint]!, mesh.bindMatrix)));
      for (let component = 0; component < 16; component++) {
        largestError = Math.max(largestError,
          Math.abs(pose.matrices[joint * 16 + component]! - expected.elements[component]!));
      }
    }
    expect(largestError).toBeLessThan(1e-5);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects revision %s", revision => {
    expect(() => captureAuthorSkinPose(fixture().mesh, revision)).toThrow("revision");
  });

  it("updates only changed joints in identity-bind rigs and preserves accepted palette", () => {
    const { mesh, bone, skeleton } = fixture();
    const second = new THREE.Bone(); mesh.add(second); skeleton.bones.push(second);
    skeleton.boneInverses[0]!.identity(); skeleton.boneInverses.push(new THREE.Matrix4());
    mesh.bindMatrix.identity(); mesh.bindMatrixInverse.identity(); mesh.updateWorldMatrix(true, true);
    const first = captureAuthorSkinPalette(mesh, 0);
    expect(captureAuthorSkinPalette(mesh, 1, first)).toBe(first);
    second.position.set(0, 4, 0); mesh.updateWorldMatrix(true, true);
    const next = captureAuthorSkinPalette(mesh, 1, first);
    expect(next.matrices.slice(0, 16)).toEqual(first.matrices.slice(0, 16));
    expect([...next.matrices]).toEqual([...captureAuthorSkinPose(mesh, 1).copyPalette().matrices]);
    expect(first.matrices[28]).toBe(0); expect(next.matrices[29]).toBe(4);
    expect(captureAuthorSkinPalette(mesh, 2, next)).toBe(next);
    // In-place author corruption must not be hidden by the accepted palette.
    bone.matrixWorld.elements[0] = NaN;
    expect(() => captureAuthorSkinPalette(mesh, 2, next)).toThrow("components");
  });

  it("falls back to exact generic bind/inverse math and rejects late invalid joints", () => {
    const { mesh, skeleton } = fixture();
    let palette = captureAuthorSkinPalette(mesh, 0);
    expect([...palette.matrices]).toEqual([...captureAuthorSkinPose(mesh, 0).copyPalette().matrices]);
    skeleton.boneInverses[0]!.identity(); mesh.bindMatrix.identity(); mesh.bindMatrixInverse.identity();
    palette = captureAuthorSkinPalette(mesh, 1, palette);
    expect([...palette.matrices]).toEqual([...captureAuthorSkinPose(mesh, 1).copyPalette().matrices]);
    const second = new THREE.Bone(); mesh.add(second); skeleton.bones.push(second);
    skeleton.boneInverses.push(new THREE.Matrix4().makeTranslation(1, 0, 0));
    second.matrixWorld.elements[4] = Infinity;
    expect(() => captureAuthorSkinPalette(mesh, 2, palette)).toThrow("components");
    second.matrixWorld.identity(); mesh.updateWorldMatrix(true, true);
    expect([...captureAuthorSkinPalette(mesh, 2, palette).matrices]).toEqual([...captureAuthorSkinPose(mesh, 2).copyPalette().matrices]);
  });

  it("matches Three vertex skinning at the 1e-4 position tolerance", () => {
    const { mesh, bone, skeleton } = fixture();
    skeleton.boneInverses[0]!.identity(); mesh.bindMatrix.identity(); mesh.bindMatrixInverse.identity();
    mesh.updateWorldMatrix(true, true);
    const palette = captureAuthorSkinPalette(mesh, 0);
    const input = prepareSkinningInput({ revision: 0, positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 1, 0]), joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]),
      weightMode: "preserve" }, palette);
    const actual = cpuSkinVertices(input);
    expect(new THREE.Vector3(actual[0]!, actual[1]!, actual[2]!).distanceTo(mesh.getVertexPosition(0, new THREE.Vector3()))).toBeLessThanOrEqual(1e-4);
    bone.position.x += 2; mesh.updateWorldMatrix(true, true);
    const next = captureAuthorSkinPalette(mesh, 1, palette);
    const changed = cpuSkinVertices(prepareSkinningInput({ revision: 0, positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 1, 0]), joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]),
      weightMode: "preserve" }, next));
    expect(new THREE.Vector3(changed[0]!, changed[1]!, changed[2]!).distanceTo(mesh.getVertexPosition(0, new THREE.Vector3()))).toBeLessThanOrEqual(1e-4);
  });

  it("rejects malformed counts, missing bones and nonfinite matrices before publishing", () => {
    const { mesh, skeleton, bone } = fixture();
    expect(() => captureAuthorSkinPose({}, 0)).toThrow("SkinnedMesh");
    skeleton.boneInverses.pop(); expect(() => captureAuthorSkinPose(mesh, 0)).toThrow("count");
    skeleton.boneInverses.push(new THREE.Matrix4());
    bone.matrixWorld.elements[0] = NaN; expect(() => captureAuthorSkinPose(mesh, 0)).toThrow("components");
    bone.matrixWorld.identity(); bone.matrixWorld.elements[3] = 1;
    expect(() => captureAuthorSkinPose(mesh, 0)).toThrow("affine");
    bone.matrixWorld.identity(); bone.matrixWorld.elements[0] = 1e40;
    expect(() => captureAuthorSkinPose(mesh, 0)).toThrow("float32");
    expect(() => captureAuthorSkinPose({ ...mesh, skeleton: { bones: [], boneInverses: [] } }, 0)).toThrow("count");
    expect(() => captureAuthorSkinPose({ ...mesh, bindMatrix: { elements: [1, 2] } }, 0)).toThrow("dimensions");
    expect(() => captureAuthorSkinPose({ ...mesh, skeleton: { bones: [null], boneInverses: [new THREE.Matrix4()] } }, 0)).toThrow("bones[0]");
  });
});
