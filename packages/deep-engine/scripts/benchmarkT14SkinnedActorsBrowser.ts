import * as THREE from "three";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";
import { captureAuthorSkinPalette, captureAuthorSkinPose } from "../src/threeBridge/authorSkinPose.js";
import { packJointPalette } from "../src/webgpu/gpuSkinningPacking.js";
import { GPU_SKINNING_WGSL } from "../src/webgpu/gpuSkinningWgsl.js";

async function benchmark(actors: number, bonesPerActor: number, samples = 7, lod = false, layout = false) {
  const geometry = new THREE.PlaneGeometry(1, 1, 7, 7);
  const vertexCount = geometry.attributes.position!.count;
  const indices = new Uint16Array(vertexCount * 4), weights = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    indices[vertex * 4] = vertex % bonesPerActor; weights[vertex * 4] = 1;
  }
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(indices, 4));
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial(), animatedBones: THREE.Bone[] = [];
  const view = { eye: [0, 0, 0] as const, target: [0, 0, -1] as const, up: [0, 1, 0] as const,
    width: 1920, height: 1080, verticalFovRadians: Math.PI / 3 };
  for (let actor = 0; actor < actors; actor++) {
    const mesh = new THREE.SkinnedMesh(geometry, material), bones: THREE.Bone[] = [];
    for (let joint = 0; joint < bonesPerActor; joint++) {
      const bone = new THREE.Bone();
      if (joint) bones[joint - 1]!.add(bone);
      bones.push(bone);
    }
    mesh.add(bones[0]!); mesh.bind(new THREE.Skeleton(bones)); root.add(mesh);
    if (layout) { mesh.position.set((actor % 25 - 12) * 9, 0, actor % 10 === 0 ? -10 : -220);
      mesh.userData.deepPoseBoundRadius = 2; }
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
  const timings: number[] = [], poseTimings: number[] = [], unchangedTimings: number[] = [];
  const heaps: number[] = [], changedPoseBytes: number[] = [];
  let uploadBytes = 0;
  let previousPoses: readonly unknown[] = [];
  for (let sample = 0; sample < samples + 2; sample++) {
    for (const bone of animatedBones) bone.rotation.z = sample * 0.01;
    root.updateWorldMatrix(true, true);
    const poseStart = performance.now();
    for (const child of root.children) captureAuthorSkinPose(child, sample).copyPalette();
    const poseMs = performance.now() - poseStart;
    const start = performance.now(), result = bridge.project(root, { cameraLayerMask: 1, ...(lod ? { view } : {}) });
    const elapsed = performance.now() - start;
    if (!result.ok) return { status: "failed", issues: result.issues };
    if (result.packet.deformation?.poses.length !== actors || !result.acknowledge()) throw new Error("Invalid pose result.");
    changedPoseBytes.push(result.packet.deformation.poses.reduce((sum, pose, index) => sum +
      (pose !== previousPoses[index] ? (pose.palette?.matrices.byteLength ?? 0) + (pose.palette?.normalMatrices?.byteLength ?? 0) : 0), 0));
    previousPoses = result.packet.deformation.poses;
    uploadBytes = result.packet.deformation.poses.reduce((sum, pose) => sum
      + (pose.palette?.matrices.byteLength ?? 0) + (pose.palette?.normalMatrices?.byteLength ?? 0), 0);
    const repeatStart = performance.now(), repeat = bridge.project(root, { cameraLayerMask: 1, ...(lod ? { view } : {}) });
    const repeatMs = performance.now() - repeatStart;
    if (!repeat.ok || !repeat.acknowledge()) throw new Error("Invalid repeat projection.");
    if (sample >= 2) { timings.push(elapsed); poseTimings.push(poseMs); unchangedTimings.push(repeatMs);
      heaps.push((performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0); }
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { status: "ok", actors, bonesPerActor, lod, layout, verticesPerActor: vertexCount,
    authorNodes: 1 + actors * (1 + bonesPerActor), uploadBytes, p50Ms: percentile(0.5),
    p95Ms: percentile(0.95), p99Ms: percentile(0.99), samplesMs: timings,
    poseSamplesMs: poseTimings, unchangedSamplesMs: unchangedTimings, heapSamplesBytes: heaps,
    changedPoseBytes: changedPoseBytes.slice(2) };
}

async function benchmarkGpuSkinning() {
  if (!navigator.gpu) return { status: "unavailable", reason: "navigator.gpu unavailable" };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { status: "unavailable", reason: "WebGPU adapter unavailable" };
  const device = await adapter.requestDevice();
  const bytes = (values: ArrayBufferView, usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({ size: values.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, values); return buffer;
  };
  const vertexCount = 64, jointCount = 64;
  const source = new Float32Array(vertexCount * 16), sourceJoints = new Uint32Array(source.buffer);
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  const bones: THREE.Bone[] = [];
  for (let joint = 0; joint < jointCount; joint++) { const bone = new THREE.Bone(); mesh.add(bone);
    bone.position.set((joint + 1) * 0.001, (joint % 7) * 0.002, 0); bones.push(bone); }
  mesh.bind(new THREE.Skeleton(bones)); mesh.updateWorldMatrix(true, true);
  const palette = captureAuthorSkinPalette(mesh, 0);
  const packed = packJointPalette(palette);
  const reference: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 16, joint = vertex % jointCount;
    source[offset] = 0.5 + vertex * 0.001; source[offset + 1] = 0.25;
    source[offset + 3] = 1; source[offset + 5] = 1;
    sourceJoints[offset + 8] = joint; source[offset + 12] = 1;
    const expected = new THREE.Vector3(source[offset]!, source[offset + 1]!, 0)
      .applyMatrix4(new THREE.Matrix4().fromArray(palette.matrices, joint * 16));
    reference.push(expected.x, expected.y, expected.z);
  }
  const input = bytes(source, GPUBufferUsage.STORAGE);
  const joints = bytes(packed, GPUBufferUsage.STORAGE);
  const params = bytes(new Uint32Array([vertexCount, jointCount, 0, 0]), GPUBufferUsage.UNIFORM);
  const output = device.createBuffer({ size: vertexCount * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: vertexCount * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const module = device.createShaderModule({ code: GPU_SKINNING_WGSL });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
  ] });
  const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: "skinVertices" } });
  const group = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: joints } },
    { binding: 2, resource: { buffer: output } }, { binding: 3, resource: { buffer: params } },
  ] });
  const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, vertexCount * 32); device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const got = new Float32Array(readback.getMappedRange().slice(0));
  let error = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) for (let axis = 0; axis < 3; axis++) {
    error = Math.max(error, Math.abs(reference[vertex * 3 + axis]! - got[vertex * 8 + axis]!));
  }
  readback.unmap();
  for (const buffer of [input, joints, params, output, readback]) buffer.destroy();
  device.destroy();
  return { status: error <= 1e-4 ? "ok" : "failed", joints: jointCount, vertices: vertexCount,
    maxPositionError: error, firstReference: reference.slice(0, 3), firstActual: [...got.slice(0, 3)] };
}

(globalThis as typeof globalThis & { __t14GpuProbe?: typeof benchmarkGpuSkinning }).__t14GpuProbe = benchmarkGpuSkinning;

(globalThis as typeof globalThis & { __t14Benchmark?: typeof benchmark }).__t14Benchmark = benchmark;
