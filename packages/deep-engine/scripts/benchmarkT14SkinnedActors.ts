import { arch, cpus, platform } from "node:os";
import * as THREE from "three";
import { captureAuthorSkinPose } from "../src/threeBridge/authorSkinPose.js";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";

const actors = Number(process.argv[2] ?? 100);
const bonesPerActor = Number(process.argv[3] ?? 24);
const samples = Number(process.argv[4] ?? 7);
if (![actors, bonesPerActor, samples].every(value => Number.isSafeInteger(value) && value > 0))
  throw new Error("Usage: benchmarkT14SkinnedActors <actors> <bones-per-actor> <samples>");

const geometry = new THREE.PlaneGeometry(1, 1, 7, 7);
const vertexCount = geometry.attributes.position!.count;
const jointIndices = new Uint16Array(vertexCount * 4);
const weights = new Float32Array(vertexCount * 4);
for (let vertex = 0; vertex < vertexCount; vertex++) {
  jointIndices[vertex * 4] = vertex % bonesPerActor;
  weights[vertex * 4] = 1;
}
geometry.setAttribute("skinIndex", new THREE.BufferAttribute(jointIndices, 4));
geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
const material = new THREE.MeshStandardMaterial();
const root = new THREE.Group();
const animatedBones: THREE.Bone[] = [];
const meshes: THREE.SkinnedMesh[] = [];
for (let actor = 0; actor < actors; actor++) {
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bones: THREE.Bone[] = [];
  for (let joint = 0; joint < bonesPerActor; joint++) {
    const bone = new THREE.Bone();
    if (joint) bones[joint - 1]!.add(bone);
    bones.push(bone);
  }
  mesh.add(bones[0]!);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.position.x = actor % 40;
  mesh.position.y = Math.floor(actor / 40);
  root.add(mesh);
  meshes.push(mesh);
  animatedBones.push(bones[bones.length - 1]!);
}
const bridge = new ThreeProjectionBridge({ capabilities: { authorDeformation: true }, hooks: {
  objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
  objectAfterRender: THREE.Object3D.prototype.onAfterRender,
  objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
  objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
  materialBeforeRender: THREE.Material.prototype.onBeforeRender,
  materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
  materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
} });

const timings: number[] = [];
let result: ReturnType<typeof bridge.project> | undefined;
let uploadBytes = 0;
for (let sample = 0; sample < samples + 2; sample++) {
  for (const bone of animatedBones) bone.rotation.z = sample * 0.01;
  root.updateWorldMatrix(true, true);
  const start = performance.now();
  result = bridge.project(root, { cameraLayerMask: 1 });
  const elapsed = performance.now() - start;
  if (!result.ok) break;
  if (!result.acknowledge()) throw new Error("Projection acknowledgement failed.");
  if (result.packet.deformation?.poses.length !== actors) throw new Error("Pose count differs from actor count.");
  uploadBytes = result.packet.deformation.poses.reduce((total, pose) => total
    + (pose.palette?.matrices.byteLength ?? 0) + (pose.palette?.normalMatrices?.byteLength ?? 0), 0);
  if (sample >= 2) timings.push(elapsed);
}
const sorted = [...timings].sort((a, b) => a - b);
const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
const poseOnly: number[] = [];
for (let sample = 0; sample < 5; sample++) {
  const start = performance.now();
  for (const mesh of meshes) captureAuthorSkinPose(mesh, sample).copyPalette();
  if (sample >= 2) poseOnly.push(performance.now() - start);
}
const poseSorted = poseOnly.sort((a, b) => a - b);
console.log(JSON.stringify({ schema: 1, scope: "Node CPU author-pose projection; excludes GPU upload and draw",
  runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  method: { actors, bonesPerActor, samples, verticesPerActor: vertexCount,
    totalAuthorNodes: 1 + actors * (1 + bonesPerActor), sharedGeometry: true },
  outcome: result?.ok ? { status: "ok", instances: result.packet.instances.length,
    poses: result.packet.deformation?.poses.length, poseUploadBytesPerFrame: uploadBytes,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), samplesMs: timings,
    isolatedPoseCaptureP50Ms: poseSorted[1] ?? null }
    : { status: "failed", issues: result?.issues },
  memory: process.memoryUsage() }, null, 2));
