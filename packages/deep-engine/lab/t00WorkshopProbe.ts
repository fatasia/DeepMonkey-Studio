import { createFactoryWorkshopScene, WORKSHOP_ASSETS, WORKSHOP_COUNTS, WORKSHOP_KIT_SOURCE,
  estimateWorkshopResidency, type WorkshopInstanceCount } from "./factoryWorkshop.js";
import { benchmarkFixtureIdentity } from "./benchmarkFixtureIdentity.js";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import { assertBenchmarkImage } from "./benchmarkImage.js";
import { benchmarkPacketSphere } from "./benchmarkPacketBounds.js";
import { sampleTrajectoryPose, type BenchmarkTrajectory, type TrajectoryCameraPose } from "@bim-studio/deep-engine";
import trajectoryCatalog from "../fixtures/benchmark-assets/trajectories-v1.json";

/**
 * T00 多资产车间证据探针:同一页面先跑 cold(首次 fetch/decode/上传/管线编译)再跑 warm
 * (解码缓存命中后重建渲染器),逐相位记录耗时、CPU/GPU 分位数、渲染器驻留快照、
 * JS 堆与画面哈希。三轮冷/热配对由采集脚本以"新页面=cold"重复三次完成。
 */

const TRAJECTORY_ID = "fixture.factory.workshop-tour-20s";
const trajectoryEntry = trajectoryCatalog.trajectories.find(value => value.id === TRAJECTORY_ID) as BenchmarkTrajectory | undefined;
if (!trajectoryEntry) throw new Error("Workshop tour trajectory missing from frozen catalog.");
const trajectory: BenchmarkTrajectory = trajectoryEntry;

let active: DeepBenchmarkBackend | undefined;

interface PhaseRequest { count: number; phase: "cold" | "warm"; sampleFrames?: number; gpuFrames?: number; identity?: boolean }

interface PhaseRecord {
  schema: 1; phase: "cold" | "warm"; count: number;
  loadMs: number; createMs: number; firstFrameCpuMs: number;
  fixture: Record<string, unknown>;
  fixtureSha256?: string;
  assetManifest?: Record<string, unknown>;
  frame: Record<string, unknown>;
  cpu: ReturnType<typeof summarize>;
  gpu: ReturnType<typeof summarize> | null;
  deviceMemory: Readonly<Record<string, unknown>> | null;
  jsHeap: Record<string, number> | null;
  image: Record<string, unknown>;
  view: Record<string, unknown>;
  errors: readonly string[];
}

function summarize(values: readonly number[]) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid sample window.");
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  return { samples: values.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

function heapSnapshot() {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit } : null;
}

const yieldTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function replayFactory(sphere: { center: { x: number; y: number; z: number }; radius: number }) {
  const transform = (value: readonly [number, number, number]): readonly [number, number, number] =>
    [sphere.center.x + value[0] * sphere.radius, sphere.center.y + value[1] * sphere.radius, sphere.center.z + value[2] * sphere.radius];
  return (elapsedMs: number): TrajectoryCameraPose => {
    const pose = sampleTrajectoryPose(trajectory, elapsedMs);
    return { position: transform(pose.position), target: transform(pose.target), fovDeg: pose.fovDeg };
  };
}

async function runPhase(request: PhaseRequest) {
  if (!WORKSHOP_COUNTS.includes(request.count as WorkshopInstanceCount)) throw new RangeError("Unknown workshop tier.");
  const { phase, count } = request;
  active?.dispose(); active = undefined;
  const sampleFrames = request.sampleFrames ?? 90;
  const gpuFrames = request.gpuFrames ?? 15;
  const canvas = document.querySelector<HTMLCanvasElement>("#candidate-canvas");
  if (!canvas) throw new Error("Missing existing benchmark canvas.");
  const signal = new AbortController().signal;
  const loadStarted = performance.now();
  const fixture = await createFactoryWorkshopScene(count as WorkshopInstanceCount, signal);
  const loadMs = performance.now() - loadStarted;
  const createStarted = performance.now();
  const backend = await DeepBenchmarkBackend.create(canvas, fixture, signal, "baseline-equivalent");
  const createMs = performance.now() - createStarted;
  try {
    backend.setGpuInstrumentation(backend.timestampSupported);
    const firstStarted = performance.now();
    const firstFrame = backend.render();
    const firstFrameCpuMs = performance.now() - firstStarted;
    await backend.settle();
    const sphere = benchmarkPacketSphere(fixture.packet);
    const replay = replayFactory(sphere);
    const durationMs = trajectory.durationMs;
    const cpu: number[] = [];
    let lastFrame = firstFrame;
    for (let index = 0; index < sampleFrames; index++) {
      backend.setCamera(replay(index / (sampleFrames - 1) * durationMs));
      const started = performance.now();
      lastFrame = backend.render();
      cpu.push(performance.now() - started);
      if (index % 30 === 29) await yieldTask();
    }
    await backend.settle();
    const gpu: number[] = [];
    if (backend.timestampSupported && gpuFrames > 0) {
      for (let index = 0; index < gpuFrames; index++) {
        backend.setCamera(replay(index / (gpuFrames - 1) * durationMs));
        const value = await backend.measureGpuFrame();
        if (value === null) break;
        gpu.push(value);
      }
    }
    const image = await backend.capture();
    assertBenchmarkImage(image, `workshop-${phase}-${count}`);
    const memoryAfter = heapSnapshot();
    const groups = fixture.layout.groups.map(group => ({ ...group }));
    const perGeometry = new Map<string, number>();
    for (const instance of fixture.packet.instances) perGeometry.set(instance.geometry, (perGeometry.get(instance.geometry) ?? 0) + 1);
    const record: PhaseRecord = {
      schema: 1, phase, count, loadMs, createMs, firstFrameCpuMs,
      fixture: { id: fixture.id, instances: fixture.packet.instances.length, geometries: fixture.packet.geometries.length,
        materials: fixture.packet.materials.length, textures: fixture.packet.textures?.length ?? 0,
        trianglesTotal: fixture.packet.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0),
        layout: { bays: fixture.layout.bays, bayColumns: fixture.layout.bayColumns, bayRows: fixture.layout.bayRows,
          fillMachines: fixture.layout.fillMachines, extentMeters: fixture.layout.extentMeters, groups },
        geometryInstanceGroups: [...perGeometry.entries()].map(([geometryId, instanceCount]) => ({ id: geometryId, instanceCount }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        residency: estimateWorkshopResidency(fixture.packet) },
      frame: { drawCalls: lastFrame.drawCalls, triangles: lastFrame.triangles, resources: lastFrame.resources },
      cpu: summarize(cpu), gpu: gpu.length ? summarize(gpu) : null,
      deviceMemory: backend.deviceMemory, jsHeap: memoryAfter,
      image: { sha256: image.sha256, meanLuminance: image.meanLuminance, geometryDetailFraction: image.geometryDetailFraction },
      view: { width: fixture.view.width, height: fixture.view.height, fovRadians: fixture.view.verticalFovRadians,
        boundingSphere: { center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius } },
      errors: backend.errors(),
    };
    if (request.identity) {
      const identity = await benchmarkFixtureIdentity(fixture);
      const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(identity)));
      record.fixtureSha256 = Array.from(new Uint8Array(digestBytes), value => value.toString(16).padStart(2, "0")).join("");
      record.assetManifest = { kit: WORKSHOP_KIT_SOURCE,
        assets: WORKSHOP_ASSETS.map(({ id, role, file, sha256 }) => ({ id, role, file, sha256 })) };
    }
    return record;
  } finally { backend.dispose(); active = undefined; }
}

/** 相机轨迹确定性证据:同一渲染器在 t=0 与 t=20000 各渲染并回读,画面哈希必须一致。 */
async function trajectoryDeterminism(count: number) {
  active?.dispose(); active = undefined;
  const canvas = document.querySelector<HTMLCanvasElement>("#candidate-canvas");
  if (!canvas) throw new Error("Missing existing benchmark canvas.");
  const fixture = await createFactoryWorkshopScene(count as WorkshopInstanceCount);
  const backend = await DeepBenchmarkBackend.create(canvas, fixture, new AbortController().signal, "baseline-equivalent");
  active = backend;
  try {
    backend.setGpuInstrumentation(backend.timestampSupported);
    const sphere = benchmarkPacketSphere(fixture.packet);
    const replay = replayFactory(sphere);
    backend.setCamera(replay(0)); backend.render(); await backend.settle();
    const first = await backend.capture();
    const poses = [0, trajectory.durationMs / 4, trajectory.durationMs / 2, 3 * trajectory.durationMs / 4, trajectory.durationMs]
      .map(timeMs => ({ timeMs, pose: replay(timeMs) }));
    backend.setCamera(replay(trajectory.durationMs)); backend.render(); await backend.settle();
    const last = await backend.capture();
    return { trajectoryId: trajectory.id, durationMs: trajectory.durationMs,
      loopClosed: first.sha256 === last.sha256, firstSha256: first.sha256, lastSha256: last.sha256,
      normalizedPoses: poses };
  } catch (error) { backend.dispose(); active = undefined; throw error; }
}

/** 供采集脚本在指定轨迹时刻截图;渲染器保持存活,由 disposeProbe 释放。 */
async function renderAtPose(count: number, timeMs: number) {
  active?.dispose(); active = undefined;
  const canvas = document.querySelector<HTMLCanvasElement>("#candidate-canvas");
  if (!canvas) throw new Error("Missing existing benchmark canvas.");
  const fixture = await createFactoryWorkshopScene(count as WorkshopInstanceCount);
  const backend = await DeepBenchmarkBackend.create(canvas, fixture, new AbortController().signal, "baseline-equivalent");
  active = backend;
  backend.setGpuInstrumentation(backend.timestampSupported);
  const replay = replayFactory(benchmarkPacketSphere(fixture.packet));
  backend.setCamera(replay(timeMs)); backend.render(); await backend.settle();
  const image = await backend.capture();
  return { count, timeMs, imageSha256: image.sha256, meanLuminance: image.meanLuminance,
    geometryDetailFraction: image.geometryDetailFraction };
}
function disposeProbe(): void { active?.dispose(); active = undefined; }

const host = globalThis as typeof globalThis & {
  __t00Workshop?: typeof runPhase;
  __t00WorkshopTrajectory?: typeof trajectoryDeterminism;
  __t00WorkshopPose?: typeof renderAtPose;
  __t00WorkshopDispose?: typeof disposeProbe;
};
host.__t00Workshop = runPhase;
host.__t00WorkshopTrajectory = trajectoryDeterminism;
host.__t00WorkshopPose = renderAtPose;
host.__t00WorkshopDispose = disposeProbe;
