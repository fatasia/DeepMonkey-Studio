/// <reference types="@webgpu/types" />
/**
 * Cluster LOD indirect executor 真机 draw 探针（A1 短切片；由 scripts/clusterLodGpuTest.mjs 驱动，
 * 与 clusterLodGpuProbe 同页同 esbuild bundle 运行，device-session 模式沿用 lab/meshletIndirectProbe 先例）。
 *
 * 路径：Node 侧用 GPU kernel 读回槽位派生 planClusterLodIndirect 命令字 → 本探针把命令字原样喂给
 * ClusterLodIndirectExecutor.encode → prepareBundle（同参连调两次，验证 bundle 缓存复用合同）→
 * render pass 内 executor.execute（executeBundles → drawIndexedIndirect）→ copyTextureToBuffer 像素读回。
 *
 * 像素判据：走廊网格 [0,32]×[0,16] 在顶点着色器线性归一化到裁剪空间。仲裁用
 * expectedClusterLodDrawCoverage 对「实际下发的 indirect 命令字」做 CPU 光栅化参考（同一拼接
 * 几何、同一像素中心采样规则），GPU 实测覆盖率须在容差内一致 —— 粗层简化几何天然不满铺
 * （顶点聚类边界内收），固定下限不 principled；逐命令流参考才能同时抓漏画与错位
 * （baseVertex/firstIndex 错位 → 几何整体位移 → 覆盖率大幅偏离）。
 * 另：空白对照（仅 clear 不绘制）覆盖像素必须为 0 —— 防止读回垃圾被误判成“已绘制”。
 * 任何 validation error / DeviceSession 诊断非空 → 对应相机 fail-closed，绝不静默降级。
 */

import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { ClusterLodIndirectExecutor, type ClusterLodGeometryBuffers,
} from "../src/webgpu/clusterLodIndirectExecutor.js";
import type { ClusterLodIndirectPlan } from "../src/rayTracing/clusterLodIndirectPlan.js";

/** 渲染目标边长（rgba8unorm；行字节数 512 满足 COPY_TO_BUFFER 的 256 对齐）。 */
export const CLUSTER_LOD_DRAW_TARGET = 128;
/** draw-indexed-indirect 命令字节数（5×u32；与 CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES 合同相等）。 */
const COMMAND_STRIDE_BYTES = 20;

export interface ClusterLodLevelGeometryPayload {
  readonly verticesBase64: string;
  readonly indicesBase64: string;
}

export interface ClusterLodDrawCameraRequest {
  readonly case: string;
  readonly label: string;
  readonly drawCount: number;
  /** Node 侧 planClusterLodIndirect 产出的 5×u32 命令字（indexCount, instanceCount, firstIndex, baseVertex, firstInstance）。 */
  readonly commands: readonly (readonly number[])[];
}

export interface ClusterLodDrawRequest {
  /** 各层 bake 几何按 level 升序（拼接顺序 = planClusterLodIndirect 的 levelSpans 合同）。 */
  readonly geometry: readonly ClusterLodLevelGeometryPayload[];
  readonly cameras: readonly ClusterLodDrawCameraRequest[];
}

export interface ClusterLodDrawCameraResult {
  readonly case: string;
  readonly label: string;
  readonly drawCount: number;
  readonly generation: number;
  readonly bundleReused: boolean;
  readonly coveredPixels: number;
  readonly totalPixels: number;
  readonly coverage: number;
}

export interface ClusterLodDrawProbeResult {
  readonly adapter: Readonly<Record<string, string>>;
  readonly cameras: readonly ClusterLodDrawCameraResult[];
  readonly clearOnlyCoveredPixels: number;
  readonly sessionDiagnostics: readonly { readonly kind: string; readonly message: string }[];
  readonly errors: readonly string[];
}

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
// 数值 usage 常量与 clusterLodGpuProbe 同风格；buffer 与 texture 的 COPY_SRC 位不同（0x4 vs 0x1），勿混用。
const BUFFER_USAGE_MAP_READ = 0x1, BUFFER_USAGE_COPY_SRC = 0x4, BUFFER_USAGE_COPY_DST = 0x8,
  BUFFER_USAGE_INDEX = 0x10, BUFFER_USAGE_VERTEX = 0x20,
  TEXTURE_USAGE_COPY_SRC = 0x1, TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

interface CoverageTriangle {
  readonly ax: number; readonly ay: number; readonly bx: number; readonly by: number;
  readonly cx: number; readonly cy: number;
  readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number;
}

/**
 * CPU 期望覆盖率（真机像素仲裁的参考半边）：同一拼接几何上对「实际下发的 indirect 命令字」做
 * CPU 光栅化参考 —— 每条命令按 (indexCount, firstIndex, baseVertex) 取三角形，像素中心采样判定，
 * 归一化合同与 drawProbePipeline 的 WGSL 一致（走廊 [0,32]×[0,16] → 裁剪空间 → target² 像素；
 * 走廊 y 翻转不改变并集覆盖，按行序等价采样）。
 * 注意期望覆盖率随相机不同：粗层简化几何（顶点聚类质心边界内收）天然不满铺，且前沿只画部分层
 * 的部分三角 —— 所以必须逐命令流参考，而不是全几何并集。WebGPU 光栅化同样按像素中心采样，
 * GPU 实测应与该值在边位噪声内一致；偏差超容差即漏画或命令字/几何拼接错位。
 */
export interface ClusterLodCoverageCommand {
  readonly indexCount: number;
  readonly firstIndex: number;
  readonly baseVertex: number;
}

export function expectedClusterLodDrawCoverage(levels: readonly {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}[], commands: readonly ClusterLodCoverageCommand[], target = CLUSTER_LOD_DRAW_TARGET): number {
  const vertexCount = levels.reduce((sum, level) => sum + level.vertices.length / 3, 0);
  const indexCount = levels.reduce((sum, level) => sum + level.indices.length, 0);
  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vertexOffset = 0, indexOffset = 0;
  for (const level of levels) {
    vertices.set(level.vertices, vertexOffset * 3);
    vertexOffset += level.vertices.length / 3;
    indices.set(level.indices, indexOffset);
    indexOffset += level.indices.length;
  }
  // 按命令流展开三角形（含 baseVertex 顶点基址），预计算走廊坐标包围盒供采样早退。
  const triangles: CoverageTriangle[] = [];
  for (const command of commands) {
    for (let corner = 0; corner < command.indexCount; corner += 3) {
      const points = [0, 1, 2].map(offset => {
        const vertex = (indices[command.firstIndex + corner + offset]! + command.baseVertex) * 3;
        return [vertices[vertex]!, vertices[vertex + 1]!] as const;
      });
      triangles.push({
        ax: points[0]![0], ay: points[0]![1], bx: points[1]![0], by: points[1]![1],
        cx: points[2]![0], cy: points[2]![1],
        minX: Math.min(...points.map(point => point[0])), maxX: Math.max(...points.map(point => point[0])),
        minY: Math.min(...points.map(point => point[1])), maxY: Math.max(...points.map(point => point[1])),
      });
    }
  }
  const edge = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
    (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  let covered = 0;
  const stepX = 32 / target, stepY = 16 / target;
  for (let row = 0; row < target; row += 1) {
    for (let column = 0; column < target; column += 1) {
      const x = (column + 0.5) * stepX, y = (row + 0.5) * stepY;
      for (const triangle of triangles) {
        if (x < triangle.minX || x > triangle.maxX || y < triangle.minY || y > triangle.maxY) continue;
        // 绕序无关的内心测试（半开边界两侧同用 ≥/≤，共享边恰计一次布尔覆盖）。
        const w0 = edge(triangle.ax, triangle.ay, triangle.bx, triangle.by, x, y);
        const w1 = edge(triangle.bx, triangle.by, triangle.cx, triangle.cy, x, y);
        const w2 = edge(triangle.cx, triangle.cy, triangle.ax, triangle.ay, x, y);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
          covered += 1;
          break;
        }
      }
    }
  }
  return covered / (target * target);
}

/** 浏览器腿：真实 WebGPU 设备上让 executor 走 encode→bundle→executeBundles→drawIndexedIndirect 并读回像素。 */
export async function runClusterLodDrawProbe(request: ClusterLodDrawRequest): Promise<ClusterLodDrawProbeResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const canvas = document.createElement("canvas");
  canvas.width = CLUSTER_LOD_DRAW_TARGET;
  canvas.height = CLUSTER_LOD_DRAW_TARGET;
  document.body.append(canvas);
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const executor = new ClusterLodIndirectExecutor(session);
  const device = session.device;
  const errors: string[] = [];
  device.addEventListener?.("uncapturederror", (event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const results: ClusterLodDrawCameraResult[] = [];
  try {
    // 拼接各层几何（level 升序）：命令字 firstIndex/baseVertex 已按该拼接合同生成，逐字对应。
    const vertexParts = request.geometry.map(level => new Float32Array(base64ToBytes(level.verticesBase64).buffer));
    const indexParts = request.geometry.map(level => new Uint32Array(base64ToBytes(level.indicesBase64).buffer));
    const vertices = new Float32Array(vertexParts.reduce((sum, part) => sum + part.length, 0));
    const indices = new Uint32Array(indexParts.reduce((sum, part) => sum + part.length, 0));
    let vertexOffset = 0, indexOffset = 0;
    for (let level = 0; level < vertexParts.length; level += 1) {
      vertices.set(vertexParts[level]!, vertexOffset);
      vertexOffset += vertexParts[level]!.length;
      indices.set(indexParts[level]!, indexOffset);
      indexOffset += indexParts[level]!.length;
    }
    const vertexBuffer = own(device.createBuffer({ label: "Deep cluster LOD draw probe vertices",
      size: vertices.byteLength, usage: BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST }));
    const indexBuffer = own(device.createBuffer({ label: "Deep cluster LOD draw probe indices",
      size: indices.byteLength, usage: BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST }));
    device.queue.writeBuffer(vertexBuffer, 0, vertices);
    device.queue.writeBuffer(indexBuffer, 0, indices);
    const geometry: ClusterLodGeometryBuffers = { indexBuffer, vertexBuffer,
      indexSize: indices.byteLength, vertexSize: vertices.byteLength };
    const pipeline = drawProbePipeline(device);
    const target = own(device.createTexture({ label: "Deep cluster LOD draw probe target",
      size: [CLUSTER_LOD_DRAW_TARGET, CLUSTER_LOD_DRAW_TARGET, 1], format: "rgba8unorm",
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC }));
    const rowBytes = CLUSTER_LOD_DRAW_TARGET * 4;
    const readback = own(device.createBuffer({ label: "Deep cluster LOD draw probe readback",
      size: rowBytes * CLUSTER_LOD_DRAW_TARGET, usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ }));
    const renderRequest = { pipeline, colorFormats: ["rgba8unorm" as const] };

    // 渲染一帧并读回覆盖像素数；同步段整体包 validation error scope，真机绑定/usage 错误显式抛错。
    const renderAndRead = async (draw: (pass: GPURenderPassEncoder) => void, label: string): Promise<number> => {
      device.pushErrorScope("validation");
      const encoder = device.createCommandEncoder({ label });
      const pass = encoder.beginRenderPass({ label, colorAttachments: [{
        view: target.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] });
      draw(pass);
      pass.end();
      encoder.copyTextureToBuffer({ texture: target },
        { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: CLUSTER_LOD_DRAW_TARGET },
        [CLUSTER_LOD_DRAW_TARGET, CLUSTER_LOD_DRAW_TARGET, 1]);
      device.queue.submit([encoder.finish()]);
      const validationError = await device.popErrorScope();
      if (validationError) throw new Error(`Cluster LOD draw probe GPU validation failed: ${validationError.message}`);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange());
      try {
        let covered = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset]! > 0) covered += 1;
        }
        return covered;
      } finally {
        readback.unmap();
      }
    };

    // 空白对照：仅 clear 不绘制，覆盖像素必须为 0 —— 防止读回垃圾被误判成“已绘制”。
    const clearOnlyCoveredPixels = await renderAndRead(() => {}, "Deep cluster LOD draw probe clear-only");
    if (clearOnlyCoveredPixels !== 0) {
      throw new Error(`Cluster LOD draw probe clear-only readback is dirty: ${clearOnlyCoveredPixels}`);
    }

    for (const camera of request.cameras) {
      try {
        // encode 只消费 indirectCommand 命令字；计划派生单一来源在 Node 侧（planClusterLodIndirect），
        // 这里按传输合同最小重建 plan 形状，绝不派生第二套口径。
        const planLike = {
          draws: camera.commands.map(command => ({ indirectCommand: command })),
          drawCount: camera.drawCount,
          commandsByteLength: camera.drawCount * COMMAND_STRIDE_BYTES,
        } as unknown as ClusterLodIndirectPlan;
        const execution = executor.encode(planLike);
        executor.prepareBundle(execution, geometry, renderRequest);
        const again = executor.prepareBundle(execution, geometry, renderRequest);
        if (!again.reused) throw new Error("Cluster LOD draw probe bundle cache did not reuse the prepared bundle.");
        const coveredPixels = await renderAndRead(
          (pass) => { executor.execute(pass, execution, geometry, renderRequest); },
          "Deep cluster LOD draw probe render");
        const totalPixels = CLUSTER_LOD_DRAW_TARGET * CLUSTER_LOD_DRAW_TARGET;
        results.push({ case: camera.case, label: camera.label, drawCount: execution.drawCount,
          generation: execution.generation, bundleReused: again.reused, coveredPixels, totalPixels,
          coverage: coveredPixels / totalPixels });
      } catch (error) {
        errors.push(`${camera.case}/${camera.label}: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    const info = session.adapterInfo;
    return {
      adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "",
        device: info?.device ?? "", description: info?.description ?? "" },
      cameras: results, clearOnlyCoveredPixels,
      sessionDiagnostics: session.diagnostics, errors,
    };
  } finally {
    executor.dispose();
    for (const resource of owned.reverse()) session.release(resource);
    session.dispose();
    canvas.remove();
  }
}

/** 最小直绘管线：走廊 [0,32]×[0,16] 线性归一化到裁剪空间，片元恒白；覆盖像素即绘制证据。 */
function drawProbePipeline(device: GPUDevice): GPURenderPipeline {
  const module = device.createShaderModule({ label: "Deep cluster LOD draw probe shader", code: /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4<f32> };
@vertex fn vertex(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position.xy / vec2<f32>(16.0, 8.0) - vec2<f32>(1.0, 1.0), 0.0, 1.0);
  return output;
}
@fragment fn fragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
` });
  return device.createRenderPipeline({ label: "Deep cluster LOD draw probe pipeline", layout: "auto",
    vertex: { module, entryPoint: "vertex",
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
    fragment: { module, entryPoint: "fragment", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" } });
}
