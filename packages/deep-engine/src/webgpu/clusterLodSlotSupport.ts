/// <reference types="@webgpu/types" />
/**
 * G1-S1 簇级微多边形绘制槽位的支撑件（纯函数 + 管线工厂，与 clusterLodRenderSlot 分职责）：
 * - PbrRendererOptions.clusterLod 开关门（缺省 undefined = 关闭，非法类型 fail-closed）；
 * - RenderView → clusterLodSelection 相机推导（与 selection 合同同式，viewport = 内部分辨率）；
 * - 槽位绘制管线（pos-only + viewProjection uniform → HDR，深度测试不写深度）。
 * 选层 kernel/WGSL 与节点/相机打包合同不在本文件重复——一律引用 rayTracing 单一来源。
 */

import { DeviceSession } from "./deviceSession.js";
import type { ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "./renderTargets.js";

/** PbrRendererOptions.clusterLod 开关门：undefined/false = 关闭；非 boolean 类型 fail-closed。 */
export function resolveClusterLodSlotOption(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError("PBR cluster LOD slot capability must be boolean.");
  return value;
}

/**
 * RenderView 相机 → clusterLodSelection.ClusterLodCamera。
 * forward = normalize(target − eye)；viewportHeightPixels = 内部分辨率高（与实际光栅像素同口径）；
 * tanHalfFovY/t阈值由调用方传入（projection.verticalFovRadians 与 staged pixelThreshold）。
 */
export function deriveClusterLodCamera(view: Pick<RenderViewCamera, "eye" | "target">,
  viewportHeightPixels: number, verticalFovRadians: number, pixelThreshold: number): ClusterLodCamera {
  const dx = view.target[0] - view.eye[0], dy = view.target[1] - view.eye[1], dz = view.target[2] - view.eye[2];
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new Error("Cluster LOD slot camera requires distinct finite eye and target.");
  }
  if (!Number.isFinite(viewportHeightPixels) || viewportHeightPixels <= 0
    || !Number.isFinite(verticalFovRadians) || verticalFovRadians <= 0 || verticalFovRadians >= Math.PI) {
    throw new Error("Cluster LOD slot camera viewport/fov must be finite and positive.");
  }
  return { position: [view.eye[0], view.eye[1], view.eye[2]],
    forward: [dx / length, dy / length, dz / length],
    viewportHeightPixels, tanHalfFovY: Math.tan(verticalFovRadians / 2), pixelThreshold };
}

export interface RenderViewCamera {
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/** 列主序 VP → 64B f32 uniform 字节（fround 量化；槽位绘制管线 group(0) binding(0)）。 */
export function packClusterLodViewProjection(viewProjection: ArrayLike<number>): ArrayBuffer {
  if (viewProjection.length !== 16) throw new Error("Cluster LOD slot view projection must be 16 elements.");
  const out = new Float32Array(16);
  for (let index = 0; index < 16; index++) {
    const value = viewProjection[index]!;
    if (!Number.isFinite(value)) throw new Error("Cluster LOD slot view projection must be finite.");
    out[index] = Math.fround(value);
  }
  return out.buffer;
}

export interface ClusterLodSlotRenderResources {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
  readonly viewProjectionBuffer: GPUBuffer;
}

/** bake 各层几何按 level 升序拼接（= clusterLodIndirectPlan.levelSpans 的拼接合同）。 */
export function concatenateLevelGeometry(levels: ReadonlyArray<{ readonly vertices: Float32Array;
  readonly indices: Uint32Array }>): { readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer> } {
  const vertices = new Float32Array(levels.reduce((sum, level) => sum + level.vertices.length, 0));
  const indices = new Uint32Array(levels.reduce((sum, level) => sum + level.indices.length, 0));
  let vertexOffset = 0, indexOffset = 0;
  for (const level of levels) {
    vertices.set(level.vertices, vertexOffset);
    indices.set(level.indices, indexOffset);
    vertexOffset += level.vertices.length;
    indexOffset += level.indices.length;
  }
  return { vertices, indices };
}

/** MAP_READ staging → u32 words（mapAsync + 拷贝 + unmap）。 */
export async function readBackWords(buffer: GPUBuffer, wordCount: number): Promise<Uint32Array> {
  await buffer.mapAsync(GPUMapMode.READ);
  try {
    return new Uint32Array(buffer.getMappedRange() as ArrayBuffer).slice(0, wordCount);
  } finally {
    buffer.unmap();
  }
}

/**
 * 槽位绘制管线：position-only 顶点 → viewProjection → clip；片元恒白。
 * HDR 单目标 + depth32float（与 pbrOpaquePass plain 路径签名逐字对应；MRT/directDisplay
 * 帧签名由槽位拒绝执行）。cullMode none（bake 保留原网格绕序，横跨正反面）；不写深度，
 * 深度测试 "less" 与主 pass 一致——槽位几何不污染后续 pass 的深度历史。
 */
export function createClusterLodSlotRenderResources(session: DeviceSession,
  viewProjection: ArrayBuffer, /** AA-M1:主 pass 生效采样数(槽位管线与主 pass 附件一致)。 */
  sampleCount: 1 | 4 = 1): ClusterLodSlotRenderResources {
  const device = session.device;
  const module = device.createShaderModule({ label: "Deep cluster LOD slot shader", code: /* wgsl */ `
struct Frame { viewProjection: mat4x4f };
@group(0) @binding(0) var<uniform> frame: Frame;
struct VertexOutput { @builtin(position) position: vec4f };
@vertex fn vertex(@location(0) position: vec3f) -> VertexOutput {
  var output: VertexOutput;
  output.position = frame.viewProjection * vec4f(position, 1.0);
  return output;
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(1.0, 1.0, 1.0, 1.0); }
` });
  const pipeline = device.createRenderPipeline({ label: "Deep cluster LOD slot pipeline", layout: "auto",
    vertex: { module, entryPoint: "vertex",
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fragment", targets: [{ format: PBR_HDR_FORMAT }] },
    depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less" },
    multisample: { count: sampleCount },
    primitive: { topology: "triangle-list", cullMode: "none" } });
  const viewProjectionBuffer = session.own(device.createBuffer({
    label: "Deep cluster LOD slot view projection", size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const bindGroup = device.createBindGroup({ label: "Deep cluster LOD slot bindings",
    layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: viewProjectionBuffer } }] });
  return { pipeline, bindGroup, viewProjectionBuffer };
}
