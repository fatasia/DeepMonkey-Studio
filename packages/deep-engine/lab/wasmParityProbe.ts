import { createAssetBenchmarkScene, createBenchmarkScene, BENCHMARK_BACKGROUND, BENCHMARK_LIGHT,
  BENCHMARK_WIDTH, BENCHMARK_HEIGHT, type BenchmarkInstanceCount,
  type BenchmarkSceneFixture } from "./benchmarkScene.js";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import { buildDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { WasmParityReport } from "./wasmParityTypes.js";

/**
 * Wasm 桥黄金样例对等验收探针(浏览器双腿,腿间独立容错)。
 *
 * 同一黄金样例分别经:
 *   - TS Deep WebGPU 路径:DeepBenchmarkBackend(生产 Studio 同源 pbrRenderer,
 *     baseline-equivalent 受控档);
 *   - Rust wasm 路径:同一 packet 经 buildDeepRuntimePackage 序列化后注入
 *     deep_engine_wasm 全引擎(set_scene_package/start_scene_viewer)。
 * 两腿同相机(9 元组逐值相同,focal=1/tan(fov/2) 与桥一致)、同光源、同背景。
 * 任一腿失败只记录该腿错误并继续另一腿(失败隔离);本文件不做任何阈值判定。
 */

interface DeepWasmRuntimeModule {
  default(input?: RequestInfo | URL | Response | BufferSource): Promise<unknown>;
  set_scene_package(bytes: Uint8Array): void;
  start_scene_viewer(canvas?: HTMLCanvasElement | null): number;
  stop_scene_viewer(handle: number): void;
  set_viewer_camera(handle: number, px: number, py: number, pz: number,
    tx: number, ty: number, tz: number, focal: number, near: number, far: number): void;
  viewer_ready_generation(): number;
  viewer_failure_message(): string | undefined;
}

export interface WasmParityRunOptions {
  readonly instances: BenchmarkInstanceCount;
  /** 第二位姿:绕目标水平旋转的角度(度)。0 = 冻结 fixture 相机。 */
  readonly orbitDegrees?: number;
  /** "FactoryMachine" = T00 冻结工业黄金样例(带纹理);"procedural" = 合成受控场景(无纹理,隔离腿)。 */
  readonly asset?: "FactoryMachine" | "procedural";
}

interface CameraTuple { readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number]; readonly fovRadians: number;
  readonly near: number; readonly far: number; readonly focal: number }

function rotateAroundY(point: readonly number[], target: readonly number[],
  degrees: number): [number, number, number] {
  if (!degrees) return [point[0], point[1], point[2]];
  const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const dx = point[0] - target[0], dz = point[2] - target[2];
  return [target[0] + dx * cos - dz * sin, point[1], target[2] + dx * sin + dz * cos];
}

function cameraFor(fixture: BenchmarkSceneFixture, orbitDegrees: number): CameraTuple {
  const view = fixture.view;
  const fov = view.verticalFovRadians, near = view.near, far = view.far;
  if (fov === undefined || near === undefined || far === undefined) {
    throw new Error("fixture view projection is incomplete");
  }
  const position = rotateAroundY(view.eye, view.target, orbitDegrees);
  // fov 为弧度;focal 与桥约定同义(1/tan(fov/2))。桥的 `fovDegrees*π/360` 是度数制,
  // 弧度制等价式是 `fov/2`,不要混用(r3 曾误用度数制公式得出 focal=145.9 的望远相机)。
  return { position, target: [view.target[0], view.target[1], view.target[2]],
    fovRadians: fov, near, far, focal: 1 / Math.tan(fov / 2) };
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function waitForFrames(frames: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = frames;
    const tick = () => (remaining-- <= 0 ? resolve() : void requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

async function waitForWasmRendererReady(module: DeepWasmRuntimeModule, before: number, timeoutMs: number): Promise<void> {
  const started = performance.now();
  for (;;) {
    const failure = module.viewer_failure_message();
    if (failure) throw new Error(`wasm renderer failure: ${failure}`);
    if (module.viewer_ready_generation() !== before) return;
    if (performance.now() - started >= timeoutMs) {
      throw new Error(`wasm renderer not ready within ${timeoutMs}ms`);
    }
    await waitForFrames(1);
  }
}

async function buildRuntimePackage(fixture: BenchmarkSceneFixture): Promise<{ bytes: Uint8Array; sha256: string;
  byteLength: number; document: Record<string, unknown> }> {
  const packet = fixture.packet;
  const camera = {
    schema: "deep-engine.scene-camera" as const, schemaVersion: 1 as const,
    id: "parity.camera", revision: 1,
    position: fixture.view.eye, target: fixture.view.target,
    verticalFovDegrees: fixture.view.verticalFovRadians * 180 / Math.PI,
    near: fixture.view.near, far: fixture.view.far,
  };
  const lightLength = Math.hypot(...BENCHMARK_LIGHT.directionWorld);
  const environment = {
    schema: "deep-engine.solid-environment" as const, schemaVersion: 2 as const,
    id: "scene.environment" as const, revision: 1 as const,
    kind: "solid-background-no-ibl" as const,
    backgroundSrgb: BENCHMARK_BACKGROUND,
    outputTransform: "native-aces-light-v2" as const,
    lighting: {
      direction: BENCHMARK_LIGHT.directionWorld.map((value) => value / lightLength) as [number, number, number],
      radiance: BENCHMARK_LIGHT.color,
      exposure: BENCHMARK_LIGHT.intensity,
      shadows: true,
    },
  };
  const runtimePackage = buildDeepRuntimePackage({
    packageId: "wasm-parity-fixture", packageVersion: "1.0.0",
    renderPacket: { id: "parity.packet", revision: 1, value: packet },
    camera, environment, materialBindings: [],
  });
  const json = serializeDeepRuntimePackage(runtimePackage);
  const bytes = new TextEncoder().encode(json);
  const document = JSON.parse(json) as Record<string, unknown>;
  return { bytes, sha256: await sha256Hex(bytes), byteLength: bytes.byteLength, document };
}

/** 从序列化文档 payloads 中按 entrypoints.renderPacket 抽取对象清单计数(找不到时返回 null)。 */
function extractPacketCounts(document: Record<string, unknown>): { instances: number; geometries: number;
  materials: number; textures: number } | null {
  const entrypoints = document.entrypoints as { renderPacket?: string } | undefined;
  const payloads = document.payloads as Record<string, { instances?: unknown[]; geometries?: unknown[];
    materials?: unknown[]; textures?: unknown[] }> | undefined;
  const packet = entrypoints?.renderPacket ? payloads?.[entrypoints.renderPacket] : undefined;
  if (!packet) return null;
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  return { instances: count(packet.instances), geometries: count(packet.geometries),
    materials: count(packet.materials), textures: count(packet.textures) };
}

async function runWebGpuLeg(fixture: BenchmarkSceneFixture, camera: CameraTuple, orbitDegrees: number,
  canvas: HTMLCanvasElement) {
  canvas.width = BENCHMARK_WIDTH; canvas.height = BENCHMARK_HEIGHT;
    const backend = await DeepBenchmarkBackend.create(canvas, fixture, new AbortController().signal, "baseline-equivalent");
    try {
      // 冻结位姿(orbitDegrees=0)直接用 fixture.view 渲染,与 T00 S1 黄金证据同一路径
      // (该证据从未经过 setCamera);仅在轨道位姿时经 setCamera 驱动。
      if (orbitDegrees !== 0) {
        backend.setCamera({ position: camera.position, target: camera.target, fovDeg: camera.fovRadians * 180 / Math.PI });
      }
      const frame = backend.render();
    await backend.settle();
    await waitForFrames(2);
    const captureA = await backend.capture();
    const captureB = await backend.capture();
    return {
      drawCalls: frame.drawCalls, triangles: frame.triangles,
      capture: { width: captureA.width, height: captureA.height, sha256: captureA.sha256,
        meanLuminance: captureA.meanLuminance, geometryDetailFraction: captureA.geometryDetailFraction },
      repeatCapture: { sha256: captureB.sha256, meanLuminance: captureB.meanLuminance,
        identical: captureA.sha256 === captureB.sha256 },
      errors: backend.errors(),
    };
  } finally { backend.dispose(); }
}

async function runWasmLeg(fixture: BenchmarkSceneFixture, camera: CameraTuple, canvas: HTMLCanvasElement) {
  canvas.width = BENCHMARK_WIDTH; canvas.height = BENCHMARK_HEIGHT;
  const compiled = await buildRuntimePackage(fixture);
  const packageSummary = { sha256: compiled.sha256, byteLength: compiled.byteLength,
    packetCounts: extractPacketCounts(compiled.document),
    documentKeys: Object.keys(compiled.document).sort() };
  const started = performance.now();
  const wasmModuleUrl = "/engine-wasm/deep_engine_wasm.js";
  const module = await import(/* @vite-ignore */ wasmModuleUrl) as unknown as DeepWasmRuntimeModule;
  await module.default();
  const moduleReadyAt = performance.now();
  const before = module.viewer_ready_generation();
  module.set_scene_package(compiled.bytes);
  const handle = module.start_scene_viewer(canvas);
  await waitForWasmRendererReady(module, before, 60_000);
  const rendererReadyAt = performance.now();
  module.set_viewer_camera(handle, camera.position[0], camera.position[1], camera.position[2],
    camera.target[0], camera.target[1], camera.target[2], camera.focal, camera.near, camera.far);
  // 相机应用后留出 winit 内部自持循环节拍,确保至少一次完整 submit+present。
  await waitForFrames(45);
  // 腿内确定性与亮度证据由 Node 侧双截图统一机制给出(winit 的 WebGPU 画布在
  // present 后内容不再可被 drawImage 读回,r3 实测恒为空白,已移除该读回)。
  const wasmLeg = {
    handle, readyGeneration: module.viewer_ready_generation() - before,
    failureMessage: module.viewer_failure_message() ?? null,
    timingsMs: { moduleLoad: Math.round(moduleReadyAt - started), rendererReady: Math.round(rendererReadyAt - moduleReadyAt) },
  };
  return { wasmLeg, packageSummary };
}

async function runLegs(options: WasmParityRunOptions): Promise<WasmParityReport> {
  const consoleErrors: string[] = [];
  const report: WasmParityReport = {
    schema: "wasm-parity-probe.v1",
    startedAt: new Date().toISOString(),
    instances: options.instances,
    orbitDegrees: options.orbitDegrees ?? 0,
    asset: options.asset ?? "FactoryMachine",
    fixture: null, package: null, webgpu: null, wasm: null,
    webgpuError: null, wasmError: null,
    consoleErrors,
    startedAtPerformance: performance.now(),
  };
  const originalError = console.error;
  console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(" ")); originalError(...args); };
  try {
    const fixture = options.asset === "procedural"
      ? createBenchmarkScene(options.instances)
      : await createAssetBenchmarkScene("FactoryMachine", options.instances);
    const counts = { instances: fixture.packet.instances.length, geometries: fixture.packet.geometries.length,
      materials: fixture.packet.materials.length, textures: fixture.packet.textures?.length ?? 0 };
    const camera = cameraFor(fixture, report.orbitDegrees);
    report.fixture = {
      id: fixture.id, assetIdentity: fixture.assetIdentity ?? null,
      counts, triangles: fixture.packet.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0),
      camera: { position: camera.position, target: camera.target,
        verticalFovDegrees: camera.fovRadians * 180 / Math.PI, near: camera.near, far: camera.far,
        focal: camera.focal },
      view: { width: BENCHMARK_WIDTH, height: BENCHMARK_HEIGHT },
    };
    const webgpuCanvas = document.querySelector<HTMLCanvasElement>("#parity-webgpu-canvas");
    const wasmCanvas = document.querySelector<HTMLCanvasElement>("#parity-wasm-canvas");
    if (!webgpuCanvas || !wasmCanvas) throw new Error("parity canvases missing");

    // ---- 腿间独立容错:一腿失败记录错误并继续另一腿。
    try {
      report.webgpu = await runWebGpuLeg(fixture, camera, report.orbitDegrees, webgpuCanvas);
    } catch (error) {
      report.webgpuError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    try {
      const { wasmLeg, packageSummary } = await runWasmLeg(fixture, camera, wasmCanvas);
      report.wasm = wasmLeg;
      report.package = packageSummary;
    } catch (error) {
      report.wasmError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  } catch (error) {
    report.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    console.error = originalError;
    report.wallMs = Math.round(performance.now() - (report.startedAtPerformance ?? 0));
  }
  return report;
}

(globalThis as typeof globalThis & { __wasmParity?: { run: typeof runLegs; ready: boolean } }).__wasmParity = {
  run: runLegs, ready: true };
