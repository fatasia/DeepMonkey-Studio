/// <reference types="@webgpu/types" />
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { SdfGiProductionRuntime } from "../src/gi/sdfGiProductionRuntime.js";
import { packInitialSdfGiRecords, packSdfGiDirectionTable, planSdfGiProbeWindow } from "../src/gi/sdfGiPacking.js";
import { sdfGiBakeInstancesFromPackets, type SdfGiPacketSnapshot } from "../src/gi/sdfGiSceneAdapter.js";
import { bakeSdfSceneGrid } from "../src/gi/sdfSceneBake.js";
import { traceSdfSkyVisibility } from "../src/gi/sdfSkyVisibility.js";
import { updateProbeShWithSdfGi, DEEP_GI_PROBE_TEMPORAL_ALPHA } from "../src/gi/probeShUpdate.js";
import { probeOcclusionDirection } from "../src/rayTracing/probeOcclusionRayExtension.js";
import { buildReferenceRoomScene } from "../src/lighting/probeReferenceScene.js";

/**
 * Brief-GI M2 真机 GPU dispatch 探针(scripts/sdf-gi-gpu.mjs 驱动,headless Chrome
 * WebGPU;模式与 lab/virtualShadowGpuProbe 同构)。
 *
 * 生产保真:直接构造生产 runtime(SdfGiProductionRuntime)+ 生产 packed 36 float
 * 批次行快照 + DeviceSession,走 encodeFrame 同一入口(烘焙帧天光追踪 dispatch +
 * 每帧预算窗口 SH 更新 dispatch)。
 *
 * 证据:test-output/sdf-gi-20261004/acceptance.json
 * 门:M2 三层混合 GPU dispatch p95 ≤ 6ms(口径:每帧独立 submit → onSubmittedWorkDone
 * 完成,120 帧采样,烘焙帧除外)+ 奇偶性(可见度/记录 readback 对 CPU 权威容差对拍)。
 */

/** 参考房间(薄墙/门洞/天窗)→ 生产 packed 批次行快照(恒等变换,全 OPAQUE 静态)。 */
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
  const interleaved = (positions: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
    const count = positions.length / 3;
    const out = new Float32Array(count * 6);
    for (let vertex = 0; vertex < count; vertex++) {
      out.set([positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!, 0, 0, 1],
        vertex * 6);
    }
    return out;
  };
  const batches = new Map<string, never>();
  const geometries = new Map<string, { source: never }>();
  meshes.forEach((mesh, index) => {
    const geometryId = `ref-room-${index}`;
    geometries.set(geometryId, { source: {
      id: geometryId, revision: 1, vertices: interleaved(mesh.positions), indices: mesh.indices } as never });
    const row = new Float32Array(36);
    row[0] = 1; row[4] = 1; row[8] = 1; // 恒等(列主)
    batches.set(`ref-batch-${index}`, { source: { key: `ref-batch-${index}`, geometry: geometryId,
      count: 1, data: row, alphaMode: "OPAQUE" } } as never);
  });
  return { batches, geometries };
}

export async function runSdfGiGpuProbe(): Promise<Record<string, unknown>> {
  const evidence: Record<string, unknown> = {};
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const errorMessages: string[] = [];
  session.device.addEventListener("uncapturederror", event => {
    errorMessages.push((event as GPUUncapturedErrorEvent).error.message);
  });
  try {
    if (session.hasErrors) throw new Error("device session reported errors at open");
    const runtime = new SdfGiProductionRuntime(session, { cellSize: 0.15, instanceDomain: "scene" });
    const instances = sdfGiBakeInstancesFromPackets(referenceRoomSnapshot());
    const cpuBake = bakeSdfSceneGrid(instances, { cellSize: 0.15, instanceDomain: "scene" });
    const directionCount = 16;
    const radiance: [number, number, number] = [1, 0.9, 0.8];
    const budget = 64;
    evidence.bakeCells = cpuBake.grid.distances.length;
    evidence.directionCount = directionCount;

    // 生产入口同步快照;首帧 = 烘焙帧(上传 + 天光追踪 dispatch)。
    runtime.syncScene(referenceRoomSnapshot());
    const bakeEncoder = session.device.createCommandEncoder({ label: "sdf-gi bake frame" });
    const bakeStart = performance.now();
    const bakePlan = runtime.encodeFrame(bakeEncoder, { sceneRevision: 1, skyRadianceRgb: radiance,
      budgetProbes: budget });
    const bakeCpuMs = performance.now() - bakeStart;
    const bakeSubmitStart = performance.now();
    session.device.queue.submit([bakeEncoder.finish()]);
    await session.device.queue.onSubmittedWorkDone();
    evidence.bakeSubmitWallMs = performance.now() - bakeSubmitStart;
    if (!bakePlan.baked) throw new Error("bake frame did not dispatch (empty scene?)");
    evidence.bakeReport = bakePlan.bakeReport;
    evidence.bakeCpuEncodeMs = bakeCpuMs;
    // 与 GPU 同源的探针格(runtime 派生;CPU 镜像/奇偶性对拍绝不另立 lattice)。
    const probePositions = runtime.probePositions;
    if (!probePositions) throw new Error("runtime did not publish its probe lattice after bake");
    evidence.probeCount = probePositions.length;

    // GPU 可见度 vs CPU 权威(traceSdfSkyVisibility)容差对拍。
    const gpuVisibility = await runtime.readVisibilities();
    const cpuVisibility = traceSdfSkyVisibility(cpuBake.grid,
      probePositions as unknown as [number, number, number][],
      unpackDirections(packSdfGiDirectionTable(directionCount)), {});
    let visibilityMaxDiff = 0;
    for (let index = 0; index < cpuVisibility.length; index++) {
      visibilityMaxDiff = Math.max(visibilityMaxDiff,
        Math.abs(gpuVisibility[index]! - cpuVisibility[index]!));
    }
    evidence.visibilityMaxAbsDiff = visibilityMaxDiff;
    evidence.visibilitySamples = cpuVisibility.length;

    // 预算窗口 SH 更新:16 帧生产 dispatch vs CPU 逐窗口镜像(时域 lerp 同式)。
    const dispatchFrames = 16;
    const windowPlan: { offset: number; count: number }[] = [];
    for (let frame = 0; frame < dispatchFrames; frame++) {
      const encoder = session.device.createCommandEncoder({ label: `sdf-gi frame ${frame}` });
      const plan = runtime.encodeFrame(encoder, { sceneRevision: 1, skyRadianceRgb: radiance,
        budgetProbes: budget });
      windowPlan.push({ ...plan.probeWindow });
      session.device.queue.submit([encoder.finish()]);
      await session.device.queue.onSubmittedWorkDone();
    }
    const gpuRecords = await runtime.readRecords();
    // CPU 镜像消费与 GPU 同一份可见度 readback(奇偶性只隔离 SH 更新核,不混入追踪差)。
    // 窗口对齐:烘焙帧已派发窗口 0(baked 帧内更新合法),GPU 总窗口 = 1 + dispatchFrames;
    // CPU 镜像跑同窗口数,错一位就是逐探针差一次 α 混合(实测踩坑:差 0.06)。
    // maxDistance 与 runtime 同式(烘焙格对角线,resolveSdfSkyVisibilityTraceConfig 缺省)。
    const traceMaxDistance = Math.hypot((cpuBake.grid.dimensions[0]! - 1) * cpuBake.grid.cellSize,
      (cpuBake.grid.dimensions[1]! - 1) * cpuBake.grid.cellSize,
      (cpuBake.grid.dimensions[2]! - 1) * cpuBake.grid.cellSize);
    const cpuRecords = cpuMirrorProbeUpdate(probePositions, directionCount, gpuVisibility, radiance,
      budget, dispatchFrames + 1, traceMaxDistance);
    let recordsMaxDiff = 0;
    for (let index = 0; index < cpuRecords.length; index++) {
      recordsMaxDiff = Math.max(recordsMaxDiff, Math.abs(gpuRecords[index]! - cpuRecords[index]!));
    }
    evidence.recordsMaxAbsDiff = recordsMaxDiff;
    evidence.updateWindows = windowPlan;

    // M2 门:三层混合 GPU dispatch ≤6ms。口径:每帧独立 submit(烘焙帧除外),
    // 120 帧采样 submit→完成墙钟(含队列开销,如实标注);另附 CPU encode p50。
    const frameMillis: number[] = [];
    const encodeMillis: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      const encoder = session.device.createCommandEncoder({ label: `sdf-gi timing ${frame}` });
      const encodeStart = performance.now();
      runtime.encodeFrame(encoder, { sceneRevision: 1, skyRadianceRgb: radiance, budgetProbes: budget });
      encodeMillis.push(performance.now() - encodeStart);
      const submitStart = performance.now();
      session.device.queue.submit([encoder.finish()]);
      await session.device.queue.onSubmittedWorkDone();
      frameMillis.push(performance.now() - submitStart);
    }
    evidence.dispatchFrameMs = percentiles(frameMillis);
    evidence.cpuEncodeMs = percentiles(encodeMillis);
    evidence.dispatchGate = {
      limitMs: 6,
      p50: percentile(frameMillis, 0.5),
      p95: percentile(frameMillis, 0.95),
      pass: percentile(frameMillis, 0.95) <= 6,
      methodology: "per-frame queue.submit → onSubmittedWorkDone wall clock, 120 samples, bake frame excluded (queue overhead included)",
    };
    evidence.parityGate = {
      visibilityTolerance: 0.02,
      recordsTolerance: 0.002,
      pass: visibilityMaxDiff <= 0.02 && recordsMaxDiff <= 0.002,
    };
    evidence.probeTemporalAlpha = DEEP_GI_PROBE_TEMPORAL_ALPHA;
    evidence.uncapturedErrors = session.hasErrors || errorMessages.length > 0;
    evidence.errorMessages = errorMessages.slice(0, 8);
    runtime.dispose();
    return evidence;
  } finally {
    session.dispose();
  }
}

// ---- 探针局部助手(确定性) ----

function unpackDirections(table: Float32Array<ArrayBuffer>): [number, number, number][] {
  const directions: [number, number, number][] = [];
  for (let index = 0; index < table.length / 4; index++) {
    directions.push([table[index * 4]!, table[index * 4 + 1]!, table[index * 4 + 2]!]);
  }
  return directions;
}

/** CPU 逐窗口镜像(GPU 核同式:天光加权均值 + α lerp;不启用 bounce 与 GPU 侧一致)。 */
function cpuMirrorProbeUpdate(positions: readonly (readonly number[])[], directionCount: number,
  visibility: Float32Array<ArrayBuffer>, radiance: readonly number[], budget: number,
  frames: number, maxDistance: number): Float32Array<ArrayBuffer> {
  const floats = new Float32Array(packInitialSdfGiRecords(positions.length, maxDistance));
  const skyRadiance = Array.from({ length: directionCount }, () =>
    [radiance[0]!, radiance[1]!, radiance[2]!] as [number, number, number]);
  const directions = Array.from({ length: directionCount }, (_, direction) =>
    probeOcclusionDirection(direction, directionCount));
  for (let frame = 0; frame < frames; frame++) {
    const window = planSdfGiProbeWindow(positions.length, budget, frame);
    const previous: ({ irradiance: [number, number, number]; validity: number;
      meanDistance: number; distanceVariance: number } | undefined)[] =
      positions.map(() => undefined);
    for (let slot = 0; slot < window.count; slot++) {
      const base = (window.offset + slot) * 24;
      previous[window.offset + slot] = { irradiance: [floats[base]!, floats[base + 1]!, floats[base + 2]!],
        validity: floats[base + 3]!, meanDistance: floats[base + 4]!, distanceVariance: floats[base + 5]! };
    }
    const result = updateProbeShWithSdfGi({
      previous, positions: positions as never, directions,
      visibilities: visibility, directionSkyRadiance: skyRadiance,
      alpha: DEEP_GI_PROBE_TEMPORAL_ALPHA,
    });
    for (let slot = 0; slot < window.count; slot++) {
      const probe = window.offset + slot;
      const record = result.records[probe]!;
      const base = probe * 24;
      floats[base] = record.irradiance[0]!;
      floats[base + 1] = record.irradiance[1]!;
      floats[base + 2] = record.irradiance[2]!;
      floats[base + 6] = record.occlusionFloor ?? 0;
    }
  }
  return floats;
}

function percentiles(values: readonly number[]): Record<string, number> {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}
