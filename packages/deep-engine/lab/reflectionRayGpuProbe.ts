/// <reference types="@webgpu/types" />
/**
 * 反射 closest-hit GPU 探针(由 scripts/reflectionRayGpuTest.mjs 驱动,headless Chrome
 * + WebGPU)。与 shadowRayGpuProbe 同构:Node 与浏览器共用同一 esbuild bundle(场景/
 * 相机/CPU 参考单一来源)。浏览器腿走完整帧通道路径:真实深度 pass(depth32float
 * depth-only 渲染)→ RayTraceClosestFramePass.encode(持久场景缓冲 → dispatch)→
 * rgba32float 命中记录 + depth + 哨兵读回;仲裁(t/法线/命中恒等、perf、f16)在 Node 侧。
 */

import { RayTraceClosestFramePass } from "../src/rayTracing/rayTraceClosestFramePass.js";
import { emitRayTraceClosestFrameKernelWgsl, RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT } from "../src/rayTracing/rayTraceClosestFrameKernel.js";
import { invertColumnMajor4x4 } from "../src/webgpu/rtShadowFrame.js";
import { lookAt, multiply, perspective } from "../src/webgpu/cameraMath.js";
import { buildReflectionScene, referenceReflectionRecords, REFLECTION_BIAS, REFLECTION_EYE,
  REFLECTION_RESOLUTION, REFLECTION_TARGET, REFLECTION_T_MAX,
  type ReflectionScene } from "./reflectionRayGpuCases.js";

export { emitRayTraceClosestFrameKernelWgsl, RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT };
export { buildReflectionScene, referenceReflectionRecords, REFLECTION_BIAS, REFLECTION_EYE,
  REFLECTION_RESOLUTION, REFLECTION_TARGET, REFLECTION_T_MAX } from "./reflectionRayGpuCases.js";

export interface ReflectionGpuCaseResult {
  readonly variant: "f32" | "f16";
  /** 命中记录 base64(Float32Array 小端字节,行主序 width×height×4)。 */
  readonly recordsBase64: string;
  /** 与内核消费同一 f32 值的主帧深度读回(行主序 width×height)。 */
  readonly depthBase64: string;
  readonly pixelCount: number;
  /** GPU dispatch 时间(ms,timestamp-query 实测;不可用为 null)。 */
  readonly gpuMs: number | null;
  /** 兜底墙钟(提交+读回整程;仅证据用,不作 perf 门)。 */
  readonly wallMs: number;
  readonly stackOverflows: number;
}

export interface ReflectionGpuProbeResult {
  readonly cases: Record<string, ReflectionGpuCaseResult>;
  readonly viewProjection: readonly number[];
  readonly invViewProjection: readonly number[];
  readonly adapter: string | null;
  readonly features: readonly string[];
  readonly shaderF16: boolean;
  readonly timestampQuery: boolean;
  readonly errors: readonly string[];
}

const RESOLUTION = REFLECTION_RESOLUTION;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function readbackF32(device: GPUDevice, texture: GPUTexture, bytesPerPixel: number): Promise<Float32Array> {
  const bytesPerRow = RESOLUTION * bytesPerPixel;
  const padded = Math.ceil(bytesPerRow / 256) * 256;
  const staging = device.createBuffer({ size: padded * RESOLUTION, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: padded,
    rowsPerImage: RESOLUTION }, [RESOLUTION, RESOLUTION]);
  device.queue.submit([encoder.finish()]);
  return staging.mapAsync(GPUMapMode.READ).then(() => {
    const paddedView = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    const out = new Float32Array(RESOLUTION * RESOLUTION * (bytesPerPixel / 4));
    // 行填充剥离(rgba32float 128px 已 256 对齐时零填充;分辨率变更时守卫正确性)。
    const rowWords = bytesPerRow / 4, padWords = padded / 4;
    for (let y = 0; y < RESOLUTION; y++) {
      out.set(paddedView.subarray(y * padWords, y * padWords + rowWords), y * rowWords);
    }
    return out;
  });
}

/** 深度 pass:depth32float depth-only 渲染(与主帧 depth 同族;无颜色附件)。 */
const DEPTH_PASS_WGSL = /* wgsl */ `
struct Vp { viewProjection: mat4x4f };
@group(0) @binding(0) var<uniform> vp: Vp;
@vertex fn vs(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return vp.viewProjection * vec4f(position, 1.0);
}
@fragment fn fs() {}
`;

/** 渲染场景深度(三角形合并绘制;三角形查询:盒 12 + 墙 2 + 板 2)。 */
async function renderSceneDepth(device: GPUDevice, scene: ReflectionScene,
  viewProjection: Float32Array<ArrayBuffer>): Promise<GPUTexture> {
  const vertices: number[] = [];
  for (const blas of scene.blasList) {
    for (let i = 0; i < blas.indices.length; i++) {
      const v = blas.indices[i]! * 3;
      vertices.push(blas.vertices[v]!, blas.vertices[v + 1]!, blas.vertices[v + 2]!);
    }
  }
  const vertexBuffer = device.createBuffer({ size: vertices.length * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(vertices));
  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniform, 0, viewProjection);
  const module = device.createShaderModule({ code: DEPTH_PASS_WGSL });
  const pipeline = device.createRenderPipeline({ layout: "auto",
    vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0,
      offset: 0, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fs", targets: [] },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
  // usage 三合一:RENDER_ATTACHMENT(深度 pass)| TEXTURE_BINDING(内核 texture_depth_2d
  // 采样)| COPY_SRC(读回仲裁)。缺 TEXTURE_BINDING 时 bind group 校验失败、整个 command
  // buffer Invalid、dispatch 被静默丢弃(真机 2026-10-05 实证;与 ShadowRayFramePass
  // 哨兵 COPY_SRC 同族教训)。
  const depthTexture = device.createTexture({ size: [RESOLUTION, RESOLUTION], format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [],
    depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: 1.0,
      depthLoadOp: "clear", depthStoreOp: "store" } });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniform } }] }));
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(vertices.length / 3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return depthTexture;
}

/** 浏览器探针主入口(page.evaluate 调用)。 */
export async function runReflectionRayGpuProbe(): Promise<ReflectionGpuProbeResult> {
  const errors: string[] = [];
  const cases: Record<string, ReflectionGpuCaseResult> = {};
  if (!("gpu" in navigator) || navigator.gpu === undefined) {
    return { cases, viewProjection: [], invViewProjection: [], adapter: null, features: [],
      shaderF16: false, timestampQuery: false, errors: ["WebGPU is not available in this context."] };
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) {
    return { cases, viewProjection: [], invViewProjection: [], adapter: null, features: [],
      shaderF16: false, timestampQuery: false, errors: ["navigator.gpu.requestAdapter() returned null."] };
  }
  const features = [...adapter.features];
  const shaderF16 = adapter.features.has("shader-f16");
  const timestampQuery = adapter.features.has("timestamp-query");
  const required: GPUFeatureName[] = [];
  if (shaderF16) required.push("shader-f16" as GPUFeatureName);
  if (timestampQuery) required.push("timestamp-query" as GPUFeatureName);
  const device = await adapter.requestDevice({ requiredFeatures: required });
  device.addEventListener?.("uncapturederror", (event: Event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const adapterInfo = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string } }).info;
  const adapterName = adapterInfo === undefined ? "unknown"
    : `${adapterInfo.vendor ?? "unknown"}/${adapterInfo.architecture ?? ""}`;
  const aspect = RESOLUTION / RESOLUTION;
  const viewProjection = multiply(perspective(50 * Math.PI / 180, aspect, 0.1, 200),
    lookAt(REFLECTION_EYE, REFLECTION_TARGET, [0, 1, 0]));
  const invViewProjection = invertColumnMajor4x4(viewProjection);
  // RayTraceClosestFramePass 合同要 16 元组(与 pbrRendererFrames 同式展开;源保证 16 长)。
  const invViewProjectionTuple = [invViewProjection[0]!, invViewProjection[1]!, invViewProjection[2]!,
    invViewProjection[3]!, invViewProjection[4]!, invViewProjection[5]!, invViewProjection[6]!,
    invViewProjection[7]!, invViewProjection[8]!, invViewProjection[9]!, invViewProjection[10]!,
    invViewProjection[11]!, invViewProjection[12]!, invViewProjection[13]!, invViewProjection[14]!,
    invViewProjection[15]!] as const;
  const variants: Array<{ variant: "f32" | "f16"; f16: boolean }> =
    [{ variant: "f32", f16: false }, ...(shaderF16 ? [{ variant: "f16" as const, f16: true }] : [])];
  for (const spec of variants) {
    try {
      const scene = buildReflectionScene(spec.f16);
      const packed = scene.tlas.packed;
      const depthTexture = await renderSceneDepth(device, scene, viewProjection);
      const pass = new RayTraceClosestFramePass(device, packed, { f16: spec.f16 });
      try {
        const depthView = depthTexture.createView();
        const hitTexture = device.createTexture({ size: [RESOLUTION, RESOLUTION], format: "rgba32float",
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
        const hitView = hitTexture.createView();
        const encode = async (): Promise<void> => {
          const encoder = device.createCommandEncoder();
          await pass.encode(encoder, { depthView, hitView, width: RESOLUTION, height: RESOLUTION,
            invViewProjection: invViewProjectionTuple, eye: REFLECTION_EYE, tMax: REFLECTION_T_MAX, bias: REFLECTION_BIAS,
            rayMask: 0xff });
          device.queue.submit([encoder.finish()]);
        };
        await encode(); // 预热(管线编译);墙钟取其后多次最小值(仅证据;帧通道无
        // timestamp 写入支持,perf 门不适用——如实标注 timingSource)。
        let bestWall = Infinity;
        for (let attempt = 0; attempt < 5; attempt++) {
          const wallStart = performance.now();
          await encode();
          bestWall = Math.min(bestWall, performance.now() - wallStart);
        }
        const records = await readbackF32(device, hitTexture, 16);
        const depth = await readbackF32(device, depthTexture, 4);
        const sentinel = new Uint32Array(4);
        const sentinelStaging = device.createBuffer({ size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const readEncoder = device.createCommandEncoder();
        pass.readbackStackOverflows(readEncoder, sentinelStaging);
        device.queue.submit([readEncoder.finish()]);
        await sentinelStaging.mapAsync(GPUMapMode.READ);
        sentinel.set(new Uint32Array(sentinelStaging.getMappedRange()));
        sentinelStaging.unmap();
        sentinelStaging.destroy();
        cases[spec.variant] = {
          variant: spec.variant, recordsBase64: toBase64(records.buffer as ArrayBuffer),
          depthBase64: toBase64(depth.buffer as ArrayBuffer),
          pixelCount: RESOLUTION * RESOLUTION, gpuMs: null, wallMs: bestWall,
          stackOverflows: sentinel[0]!,
        };
        hitTexture.destroy();
      } finally {
        pass.destroy();
        depthTexture.destroy();
      }
    } catch (error) {
      errors.push(`${spec.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  device.destroy();
  return {
    cases, viewProjection: [...viewProjection], invViewProjection: [...invViewProjection],
    adapter: adapterName, features, shaderF16, timestampQuery, errors,
  };
}
