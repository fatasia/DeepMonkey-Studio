import * as THREE from "three";
import { expect, it } from "vitest";
import { ThreeProjectionBridge } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { assertSnapshotRevisions } from "../../../../packages/deep-engine/src/webgpu/packetDeformationRevision";
import { StudioDeformationPoseSync } from "./studioDeformationPoseSync";
import { threePrototypeHooks } from "./studioDeepWebGpuBridgeSceneHelpers";

it("rebases three skinned palettes from reset author assets while preserving strict pose and child revisions", () => {
  const root = new THREE.Group(), bones: THREE.Bone[] = [];
  for (let index = 0; index < 3; index++) {
    const geometry = new THREE.PlaneGeometry(1, 1), count = geometry.attributes.position!.count;
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const weights = new Float32Array(count * 4); for (let vertex = 0; vertex < count; vertex++) weights[vertex * 4] = 1;
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial()), bone = new THREE.Bone();
    mesh.add(bone); mesh.bind(new THREE.Skeleton([bone])); root.add(mesh); bones.push(bone);
  }
  root.updateWorldMatrix(true, true);
  const compiler = new ThreeProjectionBridge({ hooks: threePrototypeHooks(), capabilities: { authorDeformation: true } });
  const projected = compiler.project(root, { cameraLayerMask: 1 }); expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error(JSON.stringify(projected.issues));
  const packet: RenderPacket = { ...projected.packet,
    objectBindings: [{ nodeId: "three-skin", instanceIds: projected.packet.instances.map(instance => instance.id) }] };
  const host = { listModels: () => [{ id: "three-skin", object: root }] };
  const sync = StudioDeformationPoseSync.create(packet, host)!;
  expect(sync.diagnostics).toEqual({ bound: 3, unmatched: [] });
  let live = packet.deformation!;
  for (let step = 1; step <= 5; step++) {
    bones.forEach((bone, index) => { bone.rotation.y = (step + index) / 10; });
    sync.apply({ updateDeformationPoses: poses => {
      const next = { ...live, poses }; assertSnapshotRevisions(next, live); live = next;
    } });
  }
  const reset: RenderPacket = { ...packet, deformation: { ...packet.deformation!,
    poses: packet.deformation!.poses.map(pose => ({ ...pose, revision: 0, palette: { ...pose.palette!, revision: 0 } })) } };
  expect(() => assertSnapshotRevisions(reset.deformation!, live)).toThrow("Stale deformation revision");
  const candidate = sync.prepareReplacement(reset, host); assertSnapshotRevisions(candidate.deformation!, live);
  expect(candidate.deformation!.poses.every(pose => pose.revision > live.poses.find(previous => previous.id === pose.id)!.revision)).toBe(true);
  expect(candidate.deformation!.poses.every(pose => pose.palette!.revision > live.poses.find(previous => previous.id === pose.id)!.palette!.revision)).toBe(true);
  const rebound = StudioDeformationPoseSync.create(candidate, host)!;
  expect(rebound.apply({ updateDeformationPoses: () => { throw new Error("unchanged palette must not reupload"); } })).toBe(false);
});
