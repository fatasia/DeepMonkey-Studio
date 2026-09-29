import { createAssetBenchmarkScene, createBenchmarkScene, BENCHMARK_BACKGROUND, BENCHMARK_LIGHT,
  BENCHMARK_WIDTH, BENCHMARK_HEIGHT, type BenchmarkInstanceCount,
  type BenchmarkSceneFixture } from "./benchmarkScene.js";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import { buildDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { WasmParityEnvironment, WasmParityGroundInjection, WasmParityReport } from "./wasmParityTypes.js";

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
 *
 * W-2 环境口径(environment):默认 `studio`——wasm 腿包环境从 v2 no-ibl 升级为
 * v8 builtin-ibl(Rust 端 builtin studio IBL),与 JS 侧 studioDeepNeutralEnvironment()
 * 的 `{kind:"studio"}` 同一待遇;TS 腿在 studio 口径同步 stage `{kind:"studio"}`
 * 环境(受控档 features.environment 由 backend 打开)。`studio-ground` 额外向
 * wasm 腿 packet 注入程序化地面网格——这是 GroundPlane 合同缺位的受控实验口径,
 * 地面对象在 package.groundInjection 显式声明,不冒充引擎内置地面能力。
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
  /** W-2 环境口径;缺省 "studio"(修复后口径),"no-ibl" 保留切片前现状供回归对照。 */
  readonly environment?: WasmParityEnvironment;
}

interface CameraTuple { readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number]; readonly fovRadians: number;
  readonly near: number; readonly far: number; readonly focal: number }

function rotateAroundY(point: readonly [number, number, number], target: readonly [number, number, number],
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

async function buildRuntimePackage(fixture: BenchmarkSceneFixture, camera: CameraTuple,
  environment: WasmParityEnvironment): Promise<{ bytes: Uint8Array; sha256: string;
  byteLength: number; document: Record<string, unknown>; groundInjection: WasmParityGroundInjection | null }> {
  const packet = fixture.packet;
  // studio-ground 受控实验:程序化地面网格(与 TS pbrGroundPass.groundMesh 同顶点合同:
  // position+normal 交错 6 floats,±1 基准,实例 XZ 缩放铺开)。albedo 0.028 为 T00 参考
  // 地面观感校准值(BENCHMARK_FLOOR=0.07 实测呈中灰、显著亮于参考的 ~35/255 暗灰地面,
  // r3 实证;校准值使地面亮度落进参考分布),对象在 groundInjection 显式声明。
  const halfSize = Math.max(160, Math.round(fixture.extent * 4));
  const groundInjection: WasmParityGroundInjection | null = environment === "studio-ground"
    ? { geometryId: "parity-ground-plane", materialId: "parity-ground-material",
        instanceId: "parity-ground", halfSize }
    : null;
  const scenepacket = groundInjection
    ? { ...packet,
        geometries: [...packet.geometries, { id: groundInjection.geometryId, revision: 1,
          vertices: new Float32Array([-1, 0, -1, 0, 1, 0, -1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
        materials: [...packet.materials, { id: groundInjection.materialId,
          baseColor: [0.028, 0.031, 0.036] as [number, number, number], metallic: 0, roughness: 1 }],
        instances: [...packet.instances, { id: groundInjection.instanceId,
          geometry: groundInjection.geometryId, material: groundInjection.materialId,
          transform: [halfSize, 0, 0, 0, 0, 1, 0, 0, 0, 0, halfSize, 0, 0, 0, 0, 1] }] }
    : packet;
  const cameraPayload = {
    schema: "deep-engine.scene-camera" as const, schemaVersion: 1 as const,
    id: "parity.camera", revision: 1,
    position: camera.position, target: camera.target,
    verticalFovDegrees: camera.fovRadians * 180 / Math.PI,
    near: camera.near, far: camera.far,
  };
  const lightLength = Math.hypot(...BENCHMARK_LIGHT.directionWorld);
  // v2(no-ibl,切片前现状)与 v8(studio:builtin IBL,lighting 沿用同向平行光)。
  // v8 合同(solid_environment.rs decode 档位门):kind 必须 solid-background-builtin-ibl、
  // outputTransform native-aces-studio-v8、不得携带 ibl 载荷。
  const environmentPayload = environment === "no-ibl"
    ? { schema: "deep-engine.solid-environment" as const, schemaVersion: 2 as const,
        id: "scene.environment" as const, revision: 1 as const,
        kind: "solid-background-no-ibl" as const,
        backgroundSrgb: BENCHMARK_BACKGROUND,
        outputTransform: "native-aces-light-v2" as const,
        lighting: {
          direction: BENCHMARK_LIGHT.directionWorld.map((value) => value / lightLength) as [number, number, number],
          radiance: BENCHMARK_LIGHT.color,
          exposure: BENCHMARK_LIGHT.intensity,
          shadows: true,
        } }
    : { schema: "deep-engine.solid-environment" as const, schemaVersion: 8 as const,
        id: "scene.environment" as const, revision: 1 as const,
        kind: "solid-background-builtin-ibl" as const,
        backgroundSrgb: BENCHMARK_BACKGROUND,
        outputTransform: "native-aces-studio-v8" as const,
        lighting: {
          direction: BENCHMARK_LIGHT.directionWorld.map((value) => value / lightLength) as [number, number, number],
          radiance: BENCHMARK_LIGHT.color,
          exposure: BENCHMARK_LIGHT.intensity,
          shadows: true,
        } };
  const runtimePackage = buildDeepRuntimePackage({
    packageId: "wasm-parity-fixture", packageVersion: "1.0.0",
    renderPacket: { id: "parity.packet", revision: 1, value: scenepacket },
    camera: cameraPayload, environment: environmentPayload, materialBindings: [],
  });
  const json = serializeDeepRuntimePackage(runtimePackage);
  const bytes = new TextEncoder().encode(json);
  const document = JSON.parse(json) as Record<string, unknown>;
  return { bytes, sha256: await sha256Hex(bytes), byteLength: bytes.byteLength, document, groundInjection };
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
  canvas: HTMLCanvasElement, environment: WasmParityEnvironment) {
  canvas.width = BENCHMARK_WIDTH; canvas.height = BENCHMARK_HEIGHT;
  // studio 口径:TS 腿同步 stage 引擎原生 `{kind:"studio"}` 中性环境(与 wasm 腿包内
  // v8 builtin-ibl 同一 Rust/TS 同源数学),no-ibl 口径保持现状(无 IBL)。
  const backend = await DeepBenchmarkBackend.create(canvas, fixture, new AbortController().signal, "baseline-equivalent",
    environment === "no-ibl" ? undefined : { kind: "studio" });
  try {
    // 冻结位姿(orbitDegrees=0)直接用 fixture.view 渲染,与 T00 S1 黄金证据同一路径
    // (该证据从未经过 setCamera);仅在轨道位姿时经 setCamera 驱动。
    if (orbitDegrees !== 0) {
      backend.setCamera({ position: camera.position, target: camera.target, fovDeg: camera.fovRadians * Math.PI / 180 });
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
  } finally {
    // 元素截图由 Node driver 在本探针返回后进行:若此处 dispose,canvas 的合成层内容
    // 会回退到旧呈现(r2c 实测截图与 no-ibl 逐位相同而 GPU 读回已变),因此 backend
    // 生命周期延后到页面销毁(探针页为一次性上下文,无泄漏面)。
    void backend;
  }
}

async function runWasmLeg(fixture: BenchmarkSceneFixture, camera: CameraTuple, canvas: HTMLCanvasElement,
  environment: WasmParityEnvironment) {
  canvas.width = BENCHMARK_WIDTH; canvas.height = BENCHMARK_HEIGHT;
  const compiled = await buildRuntimePackage(fixture, camera, environment);
  const packageSummary = { sha256: compiled.sha256, byteLength: compiled.byteLength,
    packetCounts: extractPacketCounts(compiled.document),
    documentKeys: Object.keys(compiled.document).sort(),
    groundInjection: compiled.groundInjection };
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
  const environment = options.environment ?? "studio";
  const report: WasmParityReport = {
    schema: "wasm-parity-probe.v1",
    startedAt: new Date().toISOString(),
    instances: options.instances,
    orbitDegrees: options.orbitDegrees ?? 0,
    asset: options.asset ?? "FactoryMachine",
    environment,
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
      report.webgpu = await runWebGpuLeg(fixture, camera, report.orbitDegrees, webgpuCanvas, environment);
    } catch (error) {
      report.webgpuError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    try {
      const { wasmLeg, packageSummary } = await runWasmLeg(fixture, camera, wasmCanvas, environment);
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
