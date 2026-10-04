/// <reference types="@webgpu/types" />
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { SdfGiProductionRuntime } from "../src/gi/sdfGiProductionRuntime.js";
import { sdfGiBakeInstancesFromPackets } from "../src/gi/sdfGiSceneAdapter.js";
import { bakeSdfSceneGrid } from "../src/gi/sdfSceneBake.js";
import { resolveSdfGiBakeCellSize } from "../src/gi/sdfGiBakePlan.js";
import { expectedSdfGiMomentLanes, expectedSdfGiVolumeTexel } from "../src/gi/sdfGiPublish.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { buildReferenceRoomScene } from "../src/lighting/probeReferenceScene.js";
import type { SdfGiPacketSnapshot } from "../src/gi/sdfGiSceneAdapter.js";

/**
 * Brief-GI M3 真机 parity 探针(消费接线 + GPU 烘焙;scripts/sdf-gi-m3-gpu.mjs 驱动,
 * headless Chrome WebGPU,session/runtime 构造与 lab/sdfGiGpuProbe 同构):
 * - 物化对拍:publish volume/moments 纹理 readback vs CPU 记录镜像
 *   (expectedSdfGiVolumeTexel 含 f16 量化;moments rgba32f 逐位,lane1..3 恒零);
 * - GPU 烘焙对拍:runtime.readField vs CPU bakeSdfSceneGrid 距离场
 *   (距离容差/符号翻转 cell 数如实报告)+ 墙钟对拍(GPU 帧 vs CPU bake 调用)。
 */

export interface SdfGiM3Parity {
  readonly probeCount: number;
  readonly cells: number;
  readonly volumeTexels: number;
  readonly volumeMaxAbsError: number;
  readonly volumeMismatchCount: number;
  readonly momentsLane0MismatchCount: number;
  readonly momentsLane13NonZeroCount: number;
  readonly fieldSampledCells: number;
  readonly fieldMaxAbsError: number;
  readonly fieldMeanAbsError: number;
  readonly fieldSignMismatchCount: number;
  readonly gpuBakeWallMs: number;
  readonly gpuBakeCpuMs: number;
  /** 第二次烘焙(稳态,无 shader 编译)的帧墙钟。 */
  readonly gpuRebakeWallMs: number;
  readonly cpuBakeWallMs: number;
  readonly gpuBakeUsed: boolean;
  readonly uncapturedErrors: readonly string[];
  readonly error?: string;
}

/** 纹理 → MAP_READ buffer 逐层拷贝(readback;bytesPerRow 256B 对齐合同)。 */
async function readbackTexture(device: GPUDevice, texture: GPUTexture,
  width: number, height: number, layers: number): Promise<ArrayBuffer> {
  const bytesPerTexel = texture.format === "rgba16float" ? 8 : 16;
  const bytesPerRow = Math.ceil(width * bytesPerTexel / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height * layers,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "SDF GI publish readback" });
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height },
    [width, height, layers]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const data = buffer.getMappedRange().slice(0);
  buffer.unmap(); buffer.destroy();
  return data;
}

const VOLUME_F16_TOLERANCE = 0.002; // f16 量化(10bit 尾数)对拍余量;超界即 texel 错位
const FIELD_SAMPLE_STRIDE = 7;      // 距离场抽样步长(全量 60k cells 逐位对拍改为步进抽样)

/** 参考房间 → 生产 packed 批次行快照(与 lab/sdfGiGpuProbe 的构建逐构同源,恒等变换)。 */
function referenceRoomSnapshot(): SdfGiPacketSnapshot {
  const meshes = buildReferenceRoomScene().boxes.map(box => {
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    return {
      positions: Float32Array.from([
        x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
        x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
      ]),
      indices: Uint32Array.from([
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
        3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
      ]),
    };
  });
  const batches = new Map<string, never>();
  const geometries = new Map<string, { source: never }>();
  meshes.forEach((mesh, index) => {
    const geometryId = `ref-room-${index}`;
    geometries.set(geometryId, { source: {
      id: geometryId, revision: 1, vertices: interleaveNormals(mesh.positions),
      indices: mesh.indices } as never });
    const row = new Float32Array(36);
    row[0] = 1; row[4] = 1; row[8] = 1;
    batches.set(`ref-batch-${index}`, { source: { key: `ref-batch-${index}`,
      geometry: geometryId, count: 1, data: row, alphaMode: "OPAQUE" } } as never);
  });
  return { batches, geometries };
}

/** xyz → xyz+法线交错(stride 6;烘焙只消费位置,M2 探针同构)。 */
function interleaveNormals(positions: Float32Array): Float32Array<ArrayBuffer> {
  const count = positions.length / 3;
  const out = new Float32Array(count * 6);
  for (let vertex = 0; vertex < count; vertex++) {
    out.set([positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!, 0, 0, 1],
      vertex * 6);
  }
  return out;
}

/** bytesPerRow 256B 对齐(readback buffer 行距;padding 剥离按数组口径换算)。 */
function alignedBytesPerRow(width: number, bytesPerTexel: number): number {
  return Math.ceil(width * bytesPerTexel / 256) * 256;
}

/** 真机 parity 主流程:一次 runtime 双对拍(物化纹理 + GPU 烘焙距离场/墙钟)。 */
export async function runM3Parity(): Promise<SdfGiM3Parity> {
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 240;
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const uncapturedErrors: string[] = [];
  session.device.addEventListener("uncapturederror", event => {
    uncapturedErrors.push((event as GPUUncapturedErrorEvent).error.message);
  });
  const runtime = new SdfGiProductionRuntime(session, { cellSize: 0.15, instanceDomain: "scene" });
  try {
    const instances = sdfGiBakeInstancesFromPackets(referenceRoomSnapshot());
    // CPU 权威墙钟(纯 bake 调用;与 GPU 帧墙钟对拍的基线,M2 验收实测 570ms 同口径)。
    // 对拍口径 = runtime 同一 instanceDomain(默认 aabb;漂移即误差假象)。
    const cellSize = resolveSdfGiBakeCellSize(instances, 0.15);
    const cpuBakeStart = performance.now();
    const cpuBake = bakeSdfSceneGrid(instances,
      { cellSize, instanceDomain: "scene" });
    const cpuBakeWallMs = performance.now() - cpuBakeStart;
    // GPU 帧(烘焙帧):GPU 烘焙优先;墙钟 = encode → submit → 完成信号。
    runtime.syncScene(referenceRoomSnapshot());
    const encoder = session.device.createCommandEncoder({ label: "M3 parity bake frame" });
    const bakeStart = performance.now();
    const plan = runtime.encodeFrame(encoder, { sceneRevision: 1,
      skyRadianceRgb: [1, 0.9, 0.8], budgetProbes: 64 });
    const gpuBakeCpuMs = performance.now() - bakeStart;
    session.device.queue.submit([encoder.finish()]);
    await session.device.queue.onSubmittedWorkDone();
    const gpuBakeWallMs = performance.now() - bakeStart;
    if (!plan.baked || !plan.published) throw new Error("bake/publish did not dispatch");
    // 第二次烘焙(revision 变化):分离首帧 shader 编译,得稳态烘焙墙钟。
    const warmStart = performance.now();
    const warmEncoder = session.device.createCommandEncoder({ label: "M3 parity rebake frame" });
    runtime.encodeFrame(warmEncoder, { sceneRevision: 2,
      skyRadianceRgb: [1, 0.9, 0.8], budgetProbes: 64 });
    session.device.queue.submit([warmEncoder.finish()]);
    await session.device.queue.onSubmittedWorkDone();
    const gpuRebakeWallMs = performance.now() - warmStart;
    const published = runtime.publishedTextures;
    if (!published) throw new Error("publishedTextures unavailable after bake");
    const [dx, dy, dz] = published.level.gridSize;
    const records = await runtime.readRecords();
    // volume 对拍:每 texel = record vec4[0] 经 f16 量化(透传合同;readback 行 256B
    // 对齐,行距剥离见 alignedRowStrideWords)。
    const volumeRowWords = alignedBytesPerRow(dx, 8) / 2; // Uint16Array 口径
    const volumeWords = new Uint16Array(await readbackTexture(session.device,
      published.volume, dx, dy, dz));
    let volumeMaxAbsError = 0, volumeMismatchCount = 0;
    for (let probe = 0; probe < dx * dy * dz; probe++) {
      const x = probe % dx, y = Math.floor(probe / dx) % dy, z = Math.floor(probe / (dx * dy));
      const expected = expectedSdfGiVolumeTexel({ irradiance: [
        records[probe * 24]!, records[probe * 24 + 1]!, records[probe * 24 + 2]!],
        validity: records[probe * 24 + 3]! });
      const base = (z * dy + y) * volumeRowWords + x * 4;
      for (let channel = 0; channel < 4; channel++) {
        const error = Math.abs(decodeHalfFloat(volumeWords[base + channel]!) - expected[channel]!);
        volumeMaxAbsError = Math.max(volumeMaxAbsError, error);
        if (error > VOLUME_F16_TOLERANCE) volumeMismatchCount += 1;
      }
    }
    // moments lane0 对拍(rgba32f 逐位)+ lane1..3 恒零(F5 SH 缺失合同)。
    const momentsRowWords = alignedBytesPerRow(dx, 16) / 4; // Float32Array 口径
    const momentsWords = new Float32Array(await readbackTexture(session.device,
      published.moments, dx, dy, dz * 4));
    let momentsLane0MismatchCount = 0, momentsLane13NonZeroCount = 0;
    for (let probe = 0; probe < dx * dy * dz; probe++) {
      const x = probe % dx, y = Math.floor(probe / dx) % dy, z = Math.floor(probe / (dx * dy));
      const expected = expectedSdfGiMomentLanes({ meanDistance: records[probe * 24 + 4]!,
        distanceVariance: records[probe * 24 + 5]!, occlusionFloor: records[probe * 24 + 6]! });
      const lane0 = ((z * 4) * dy + y) * momentsRowWords + x * 4;
      for (let channel = 0; channel < 4; channel++) {
        if (momentsWords[lane0 + channel] !== expected[channel]) momentsLane0MismatchCount += 1;
      }
      for (let lane = 1; lane < 4; lane++) {
        const laneBase = ((z * 4 + lane) * dy + y) * momentsRowWords + x * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (momentsWords[laneBase + channel] !== 0) momentsLane13NonZeroCount += 1;
        }
      }
    }
    // GPU 烘焙距离场对拍(GPU 帧 vs CPU 权威,步进抽样;差异如实报告)。
    const field = await runtime.readField();
    const cpu = cpuBake.grid.distances;
    let fieldMaxAbsError = 0, fieldSumError = 0, fieldSignMismatchCount = 0, sampled = 0;
    for (let cell = 0; cell < Math.min(field.length, cpu.length); cell += FIELD_SAMPLE_STRIDE) {
      sampled += 1;
      const error = Math.abs(field[cell]! - cpu[cell]!);
      fieldMaxAbsError = Math.max(fieldMaxAbsError, error);
      fieldSumError += error;
      if ((field[cell]! < 0) !== (cpu[cell]! < 0)) fieldSignMismatchCount += 1;
    }
    return Object.freeze({
      probeCount: plan.probeCount,
      cells: plan.bakeReport
        ? plan.bakeReport.dimensions[0]! * plan.bakeReport.dimensions[1]! * plan.bakeReport.dimensions[2]!
        : 0,
      volumeTexels: dx * dy * dz, volumeMaxAbsError, volumeMismatchCount,
      momentsLane0MismatchCount, momentsLane13NonZeroCount,
      fieldSampledCells: sampled, fieldMaxAbsError,
      fieldMeanAbsError: fieldSumError / Math.max(sampled, 1), fieldSignMismatchCount,
      gpuBakeWallMs, gpuBakeCpuMs, gpuRebakeWallMs, cpuBakeWallMs, gpuBakeUsed: plan.gpuBaked,
      uncapturedErrors,
    });
  } catch (error) {
    return { probeCount: 0, cells: 0, volumeTexels: 0, volumeMaxAbsError: 0, volumeMismatchCount: 0,
      momentsLane0MismatchCount: 0, momentsLane13NonZeroCount: 0, fieldSampledCells: 0,
      fieldMaxAbsError: 0, fieldMeanAbsError: 0, fieldSignMismatchCount: 0, gpuBakeWallMs: 0,
      gpuBakeCpuMs: 0, gpuRebakeWallMs: 0, cpuBakeWallMs: 0, gpuBakeUsed: false, uncapturedErrors,
      error: String(error) };
  } finally {
    runtime.dispose();
    session.dispose();
  }
}
