/// <reference types="@webgpu/types" />
/**
 * T05 验收切片真机探针：生产实例剔除内核在真实 WebGPU 设备上运行并读回。
 * 视锥腿：GPU_FRUSTUM_CULL_WGSL（createGpuCullingPipelineContext 生产路径）读回存活计数；
 * 遮挡腿：生产 HiZOcclusionCuller 类 + Node 参考深度 r32float mip 链，读回 visibleIndices。
 * 仲裁在 Node 侧（instanceCullingGpuTest.mjs）：参考可见集 ⊆ GPU 保留集（零错误漏剔）。
 * Hi-Z 静态场景口径：帧间瞬态不在本切片。由 instanceCullingGpuTest.mjs 驱动。
 */

import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { createGpuCullingPipelineContext } from "../src/webgpu/gpuFrustumCulling.js";
import { HiZOcclusionCuller } from "../src/webgpu/hiZOcclusionCulling.js";
import type { HiZResult } from "../src/webgpu/hiZPyramid.js";

// Node 侧 runner 与浏览器腿共用同一 bundle：场景/参考集构建单一来源（Buffer 仅在 Node 调用）。
export { buildCullingGpuScene } from "./instanceCullingGpuFixture.js";

export interface InstanceCullingGpuRequest {
  readonly instancesBase64: string;
  readonly boundsBase64: string;
  readonly frustumBase64: string;
  readonly viewProjectionBase64: string;
  readonly cameraPosition: readonly [number, number, number];
  readonly viewport: readonly [number, number];
  readonly instanceCount: number;
  readonly indexCount: number;
  /** 参考深度 mip 链（视图深度约定）。 */
  readonly depthMips: readonly { readonly width: number; readonly height: number; readonly dataBase64: string }[];
  readonly reversedZ: boolean;
}

export interface InstanceCullingGpuResult {
  readonly adapter: Readonly<Record<string, string | number>>;
  readonly frustumSurvivors: number;
  readonly hizVisibleCount: number;
  readonly hizIndicesBase64: string;
  readonly uploadedMips: readonly { readonly width: number; readonly height: number; readonly values: readonly number[];
    readonly firstRowHex?: string }[];
  /** 页内纹理通路微测试诊断（本环境 writeTexture/copyTextureToBuffer 回读不可信的证据）。 */
  readonly microTest: string;
  readonly errors: readonly string[];
}

const fromBase64Labeled = (value: string, label: string): Uint8Array => {
  try { return fromBase64(value); }
  catch {
    const head = typeof value === "string" ? value.slice(0, 32) : String(value);
    throw new Error("base64 decode failed for " + label + ": len=" + value?.length + " head=" + head);
  }
};
const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

async function readBack(device: GPUDevice, buffer: GPUBuffer): Promise<ArrayBuffer> {
  await buffer.mapAsync(0x1);
  try { return new Uint8Array(buffer.getMappedRange() as ArrayBuffer).slice().buffer; }
  finally { buffer.unmap(); }
}

/** 页内微测试：已知值 writeTexture→copyTextureToBuffer 回读，验证纹理上传/回读通路本身。 */
async function textureRoundTripMicroTest(device: GPUDevice): Promise<string> {
  const values = [0.25, 0.5, 0.75, 1, 0, 0.5, 0.25, 0, 1, 0.75, 0.5, 0.25, 0.5, 1, 0, 0.75];
  const texture = device.createTexture({ label: "micro-test", size: [4, 4, 1], format: "r32float",
    mipLevelCount: 1, usage: 0x4 | 0x2 | 0x1 });
  device.queue.writeTexture({ texture }, new Float32Array(values),
    { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4]);
  const readback = device.createBuffer({ label: "micro-test-readback", size: 256 * 3 + 16,
    usage: 0x8 | 0x1 }); // bytesPerRow*(rows-1)+lastRow = 784（256 对齐合同）。
  const encoder = device.createCommandEncoder({ label: "micro-test" });
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(0x1);
  const floats = new Float32Array(readback.getMappedRange()).slice();
  readback.unmap();
  readback.destroy();
  texture.destroy();
  return "micro=" + Array.from(floats.slice(0, 16)).map(value => value.toFixed(2)).join(",");
}

export async function runInstanceCullingGpuProbe(request: InstanceCullingGpuRequest): Promise<InstanceCullingGpuResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const canvas = document.createElement("canvas");
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const device = session.device;
  const own = <T extends GPUBuffer>(buffer: T): T => { session.own(buffer); return buffer; };
  const errors: string[] = [];
  device.addEventListener?.("uncapturederror", event => errors.push((event as GPUUncapturedErrorEvent).error.message));
  let microTest = "";
  try {
    microTest = await textureRoundTripMicroTest(device);
    const instanceBytes = fromBase64Labeled(request.instancesBase64, "instances");
    const floats = new Float32Array(instanceBytes.buffer, 0, request.instanceCount * 36);
    const cullingInstances = Array.from({ length: request.instanceCount }, (_, index) => ({
      instanceData: floats.subarray(index * 36, index * 36 + 36),
      previousTransform: floats.subarray(index * 36, index * 36 + 12),
      bounds: [0, 0, 0, 1] as const }));
    const context = createGpuCullingPipelineContext(device, session);
    const shared = context.createSharedInputs(request.instanceCount);
    const phase = shared.createPhase(request.indexCount);
    const planes = Array.from(new Float32Array(fromBase64(request.frustumBase64).buffer)).reduce<number[][]>(
      (rows, value, index) => {
        if (index % 4 === 0) rows.push([value]);
        else rows[rows.length - 1]!.push(value);
        return rows;
      }, []).map(row => [row[0]!, row[1]!, row[2]!, row[3]!] as const);
    shared.writeInstances(device.queue, cullingInstances);
    phase.writeView(device.queue, { planes });
    const counterReadback = own(device.createBuffer({ label: "Deep probe cull counter readback", size: 4,
      usage: 0x8 | 0x1 }));
    const encoder = device.createCommandEncoder({ label: "Deep frustum culling probe" });
    phase.encode(encoder);
    encoder.copyBufferToBuffer(phase.counter, 0, counterReadback, 0, 4);
    device.queue.submit([encoder.finish()]);
    const frustumSurvivors = new Uint32Array(await readBack(device, counterReadback))[0]!;

    // 遮挡腿：生产 HiZOcclusionCuller + 参考深度 mip 链（r32float，逐级 writeTexture）。
    const texture = session.own(device.createTexture({ label: "Deep probe reference Hi-Z",
      size: [request.depthMips[0]!.width, request.depthMips[0]!.height, 1], format: "r32float",
      mipLevelCount: request.depthMips.length, usage: 0x4 | 0x2 | 0x1 })); // TEXTURE_BINDING | COPY_DST | COPY_SRC

    // 上传走 writeTexture + 256 对齐行填充（WebGPU bytesPerRow 合同）。本环境 harness
    // 纹理上传/回读经三种变体实测不可信（微测试：教科书式 writeTexture→copyTextureToBuffer
    // 回读全零，诊断含在结果 microTest），因此本探针的真机 Hi-Z 腿结论按 partial 处理，
    // 不作为生产核裁决；生产核语义由 CPU 孪生 vitest 套件与 r4-hiz-wiring 真机证据覆盖。
    request.depthMips.forEach((mip, level) => {
      const data = new Float32Array(fromBase64Labeled(mip.dataBase64, "mip" + level).buffer);
      const rowBytes = mip.width * 4;
      const padded = Math.max(256, Math.ceil(rowBytes / 256) * 256);
      if (padded === rowBytes) {
        device.queue.writeTexture({ texture, mipLevel: level }, data,
          { bytesPerRow: rowBytes, rowsPerImage: mip.height }, [mip.width, mip.height]);
        return;
      }
      const packed = new Uint8Array(padded * mip.height);
      const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      for (let row = 0; row < mip.height; row++) {
        packed.set(source.subarray(row * rowBytes, (row + 1) * rowBytes), row * padded);
      }
      device.queue.writeTexture({ texture, mipLevel: level }, packed,
        { bytesPerRow: padded, rowsPerImage: mip.height }, [mip.width, mip.height]);
    });
    const hiz: HiZResult = { texture, format: "r32float", width: request.depthMips[0]!.width,
      height: request.depthMips[0]!.height, mipLevelCount: request.depthMips.length,
      levels: request.depthMips.map((mip, level) => ({ level, width: mip.width, height: mip.height,
        view: texture.createView({ format: "r32float", dimension: "2d", baseMipLevel: level,
          mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 }) })),
      sourceRevision: 1, reversedZ: request.reversedZ,
      reduction: request.reversedZ ? "min" : "max", updated: true };
    const culler = new HiZOcclusionCuller(session);
    const indicesReadback = own(device.createBuffer({ label: "Deep probe hiz indices readback",
      size: request.instanceCount * 4, usage: 0x8 | 0x1 }));
    const countReadback = own(device.createBuffer({ label: "Deep probe hiz count readback", size: 4,
      usage: 0x8 | 0x1 }));
    try {
      const viewProjection = new Float32Array(fromBase64Labeled(request.viewProjectionBase64, "viewProjection").buffer.slice(0));
      const hizEncoder = device.createCommandEncoder({ label: "Deep hiz occlusion probe" });
      const result = culler.encode(hizEncoder, {
        instances: shared.input, bounds: shared.bounds, count: request.instanceCount, revision: 1,
        indexCount: request.indexCount }, {
        viewProjection: [...viewProjection], cameraPosition: request.cameraPosition,
        viewport: request.viewport, hiz, reversedZ: request.reversedZ }, { temporal: false });
      if (result.mode !== "indirect") throw new Error("Hi-Z occlusion probe expected indirect mode.");
      hizEncoder.copyBufferToBuffer(result.visibleIndices, 0, indicesReadback, 0, request.instanceCount * 4);
      hizEncoder.copyBufferToBuffer(result.visibleCount, 0, countReadback, 0, 4);
      device.queue.submit([hizEncoder.finish()]);
    } finally { culler.dispose(); }
    // 上传保真度证据：回读全部 mip（256 对齐行），供 Node 与期望金字塔逐级比对。
    const uploadedMips: { width: number; height: number; values: number[] }[] = [];
    const mipEncoder = device.createCommandEncoder({ label: "Deep probe hiz mip readback" });
    const mipReadbacks: GPUBuffer[] = [];
    const mipShapes: { width: number; height: number; rowBytes: number; padded: number }[] = [];
    request.depthMips.forEach((mip) => {
      const rowBytes = mip.width * 4;
      const padded = Math.max(256, Math.ceil(rowBytes / 256) * 256);
      const readback = own(device.createBuffer({ label: "Deep probe hiz mip readback",
        size: padded * mip.height, usage: 0x8 | 0x1 }));
      mipReadbacks.push(readback);
      mipShapes.push({ width: mip.width, height: mip.height, rowBytes, padded });
      mipEncoder.copyTextureToBuffer({ texture, mipLevel: request.depthMips.indexOf(mip) },
        { buffer: readback, bytesPerRow: padded, rowsPerImage: mip.height }, [mip.width, mip.height]);
    });
    device.queue.submit([mipEncoder.finish()]);
    for (const [index, readback] of mipReadbacks.entries()) {
      const shape = mipShapes[index]!;
      const bytes = new Uint8Array(await readBack(device, readback));
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset);
      const values: number[] = [];
      for (let row = 0; row < shape.height; row++) for (let column = 0; column < shape.width; column++) {
        values.push(floats[row * (shape.padded / 4) + column]!);
      }
      const hex = (bytes: Uint8Array, count: number): string => [...bytes.subarray(0, count)]
        .map(value => value.toString(16).padStart(2, "0")).join("");
      uploadedMips.push({ width: shape.width, height: shape.height, values,
        firstRowHex: hex(bytes, Math.min(32, shape.rowBytes)) });
    }
    const indices = new Uint32Array(await readBack(device, indicesReadback));
    const hizVisibleCount = new Uint32Array(await readBack(device, countReadback))[0]!;
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    return { adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "",
      device: info?.device ?? "", description: info?.description ?? "" },
      frustumSurvivors, hizVisibleCount,
      hizIndicesBase64: toBase64(new Uint8Array(indices.buffer, indices.byteOffset, hizVisibleCount * 4)),
      uploadedMips, microTest,
      errors };
  } finally {
    session.dispose();
  }
}
