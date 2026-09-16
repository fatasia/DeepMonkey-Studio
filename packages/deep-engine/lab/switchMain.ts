import * as THREE from "three";
import { BackendPreferenceController, BackendSwitchCoordinator } from "../src/index.js";
import { BackendCanvasDeck, bindBackendCanvas, DeepWebGpuBackend, ThreeProjectionBridge,
  projectThreeWorldLights, threeRenderView, type CanvasBoundBackend } from "../src/threeBridge/index.js";
import type { RenderView } from "../src/webgpu/index.js";
import { domCanvasHost, domCanvasSurface, type DomCanvasSurface } from "./domCanvasPort.js";
import { ThreeSwitchBackend } from "./threeSwitchBackend.js";

interface AuthorState {
  revision: number;
  readonly root: THREE.Group;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly selection: Set<string>;
  unsaved: boolean;
  readonly script: { ticks: number };
}

type InnerBackend = ThreeSwitchBackend | DeepWebGpuBackend;
type SwitchBackend = CanvasBoundBackend<InnerBackend>;
interface PublishedFrameProof {
  readonly backend: "three" | "deep-webgpu";
  readonly gpuFenceCompleted: true;
  readonly width: number;
  readonly height: number;
  readonly centerNonBlack?: boolean;
  readonly resources?: number;
  readonly lightCount?: number;
}
interface SwitchRecord {
  readonly target: string; readonly result: string; readonly active: string;
  readonly elapsedMs: number; readonly revision: number; readonly scriptTicks: number;
  readonly surfaces: number; readonly proof: PublishedFrameProof;
}

const get = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing switch lab element: ${id}`);
  return value as T;
};
const status = get("switch-status"), select = get<HTMLSelectElement>("backend");
const runTwenty = get<HTMLButtonElement>("roundtrip"), canvasHost = get("canvas-host");
const initialCanvas = get<HTMLCanvasElement>("three-canvas");
const records: SwitchRecord[] = [], failures: string[] = [];
const state = createState();
const deck = new BackendCanvasDeck(domCanvasHost(canvasHost), "three", domCanvasSurface(initialCanvas));
let coordinator: BackendSwitchCoordinator<AuthorState, SwitchBackend>;
let preference: BackendPreferenceController<AuthorState, SwitchBackend>;
let busy = false, closed = false, raf = 0;
let buildSha256 = "";

function createState(): AuthorState {
  const root = new THREE.Group(); root.name = "shared-author-root";
  const material = new THREE.MeshStandardMaterial({ color: 0xd59a3a, roughness: 0.34, metalness: 0.42 });
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.82, 0.26, 96, 16), material);
  mesh.name = "shared-knot"; root.add(mesh); root.updateWorldMatrix(true, true);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101820); scene.add(root);
  const key = new THREE.DirectionalLight(0xffffff, 3.1); key.position.set(3, 5, 4);
  const fill = new THREE.DirectionalLight(0x9fb8d6, 0.7); fill.position.set(-4, 2, -3);
  scene.add(key, key.target, fill, fill.target);
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.05, 100);
  camera.position.set(3.2, 2.2, 4.3); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  return { revision: 1, root, scene, camera, selection: new Set([mesh.uuid]),
    unsaved: true, script: { ticks: 0 } };
}

function bridge(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
    objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
    objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender,
    materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });
}

function nativeCanvas(backend: SwitchBackend): HTMLCanvasElement {
  return (backend.surface.canvas as DomCanvasSurface).native;
}

function view(canvas: HTMLCanvasElement): RenderView {
  state.camera.updateMatrixWorld(true);
  state.scene.updateWorldMatrix(true, true);
  const projected = projectThreeWorldLights(state.scene, { cameraLayerMask: state.camera.layers.mask });
  if (!projected.ok) throw new Error(`Three light projection failed: ${projected.issues.map(issue => issue.message).join("; ")}`);
  return threeRenderView({ camera: state.camera, target: [0, 0, 0],
    width: Math.max(1, canvas.clientWidth || canvas.width),
    height: Math.max(1, canvas.clientHeight || canvas.height), pixelRatio: 1, extent: 3,
    background: [0.005, 0.009, 0.014], floor: [0.035, 0.045, 0.055], exposure: 1, roughness: 1,
    lights: projected.lights });
}

async function createBackend(id: string, _state: AuthorState, signal: AbortSignal): Promise<SwitchBackend> {
  const surface = deck.reserve(id);
  const canvas = (surface.canvas as DomCanvasSurface).native;
  try {
    const backend: InnerBackend = id === "three"
      ? await ThreeSwitchBackend.create(canvas, state.scene, state.camera, signal)
      : await DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu,
        projection: bridge(), root: state.root, view: view(canvas), signal,
        renderer: { features: { environment: false, fog: false, groundGrid: false,
          ambientOcclusion: false, temporalAa: false, occlusionCulling: false,
          bloom: false, vignette: false, toneMapping: "three-aces-r185" } } });
    return bindBackendCanvas(backend, surface);
  } catch (error) {
    surface.dispose();
    throw error;
  }
}

async function catchUp(candidate: SwitchBackend, revision: number, signal: AbortSignal): Promise<number> {
  if (candidate.backend instanceof DeepWebGpuBackend) {
    const synced = await candidate.backend.sync(state.root, 1, signal);
    if (synced.status !== "committed") throw new Error(`Deep catch-up ${synced.status}.`);
    await candidate.backend.runtime.validateFrame(view(nativeCanvas(candidate)));
  } else await candidate.backend.validateFrame(signal);
  return revision;
}

async function validatePublishedFrame(backend: SwitchBackend): Promise<PublishedFrameProof> {
  if (backend.backend instanceof DeepWebGpuBackend) {
    const frame = await backend.backend.runtime.validateFrame(view(nativeCanvas(backend)));
    return Object.freeze({ backend: "deep-webgpu", gpuFenceCompleted: true,
      width: frame.width, height: frame.height, resources: frame.resources, lightCount: frame.lightCount });
  }
  const frame = await backend.backend.validateFrame();
  const centerNonBlack = frame.centerRgba[3] === 255
    && frame.centerRgba.slice(0, 3).some(channel => channel > 0);
  if (!centerNonBlack) throw new Error("Published Three frame became blank after surface handoff.");
  return Object.freeze({ backend: "three", gpuFenceCompleted: true,
    width: frame.width, height: frame.height, centerNonBlack });
}

async function frameBoundary(publish: () => void, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cancelAnimationFrame(frame); reject(abortError()); };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort);
      try { publish(); resolve(); } catch (error) { reject(error); }
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function boot(): Promise<void> {
  const response = await fetch("/manifest.json");
  if (!response.ok) throw new Error(`Build manifest request failed: ${response.status}.`);
  const manifest = await response.json() as { sha256?: unknown };
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("Build manifest identity is invalid.");
  }
  buildSha256 = manifest.sha256;
  const controller = new AbortController();
  const first = bindBackendCanvas(await ThreeSwitchBackend.create(initialCanvas,
    state.scene, state.camera, controller.signal), deck.initial);
  coordinator = new BackendSwitchCoordinator(first, {
    state, prepare: createBackend, atFrameBoundary: frameBoundary,
    publishSurface: (next, previous) => deck.publish(next.surface, previous.surface),
    revisionBarrier: { read: current => current.revision,
      catchUp: (candidate, _current, revision, signal) => catchUp(candidate, Number(revision), signal) },
    timeoutMs: 30_000,
  });
  preference = new BackendPreferenceController(coordinator, {
    load: async () => localStorage.getItem("deep-engine.backend"),
    save: async id => localStorage.setItem("deep-engine.backend", id),
  }, ["three", "deep-webgpu"]);
  const result = await preference.initialize();
  select.value = coordinator.active.id;
  setStatus(result.status === "fallback" ? `回退至 ${coordinator.active.id}` : `已就绪：${coordinator.active.id}`,
    result.status === "fallback");
  updateMetrics();
}

async function choose(id: string): Promise<void> {
  const started = performance.now(), root = state.root, script = state.script, selection = state.selection;
  const result = await preference.select(id);
  if (state.root !== root || state.script !== script || state.selection !== selection) {
    throw new Error("Author state identity changed during renderer switch.");
  }
  if (result.status !== "applied" && result.status !== "unchanged") {
    throw new Error(result.snapshot.error ?? `Renderer switch ${result.status}.`);
  }
  if (deck.surfaceCount !== 1 || deck.active !== coordinator.active.surface) {
    throw new Error("Renderer surface ownership did not converge after publication.");
  }
  const proof = await validatePublishedFrame(coordinator.active);
  records.push(Object.freeze({ target: id, result: result.status, active: coordinator.active.id,
    elapsedMs: performance.now() - started, revision: state.revision, scriptTicks: state.script.ticks,
    surfaces: deck.surfaceCount, proof }));
  select.value = coordinator.active.id; updateMetrics();
}

async function action(run: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true; select.disabled = true; runTwenty.disabled = true; setStatus("正在预热候选后端…");
  try { await run(); setStatus(`✓ 当前 ${coordinator.active.id} · 作者状态与脚本连续`); }
  catch (error) { fail(error); select.value = coordinator.active.id; }
  finally { busy = false; select.disabled = false; runTwenty.disabled = false; updateMetrics(); }
}

function updateMetrics(): void {
  get("active").textContent = coordinator?.active.id ?? "—";
  get("surfaces").textContent = String(deck.surfaceCount);
  get("ticks").textContent = state.script.ticks.toLocaleString();
  get("switches").textContent = String(records.length);
  get("switch-diagnostics").textContent = JSON.stringify({ buildSha256, records, failures }, null, 2);
}

function setStatus(message: string, error = false): void {
  status.textContent = message; status.dataset.state = error ? "error" : "ready";
}
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(message); setStatus(`切换失败，旧引擎继续运行：${message}`, true); updateMetrics();
}
function abortError(): Error { const error = new Error("Frame publication cancelled."); error.name = "AbortError"; return error; }

select.onchange = () => void action(() => choose(select.value));
runTwenty.onclick = () => void action(async () => {
  const initialRoot = state.root, initialScript = state.script;
  const start = records.length;
  for (let index = 0; index < 20; index++) {
    await choose(index % 2 === 0 ? "deep-webgpu" : "three");
  }
  if (state.root !== initialRoot || state.script !== initialScript) throw new Error("Round-trip replaced shared author state.");
  const run = records.slice(start), deepResources = run.flatMap(record =>
    record.proof.backend === "deep-webgpu" ? [record.proof.resources!] : []);
  if (run.length !== 20 || run.some(record => !record.proof.gpuFenceCompleted || record.surfaces !== 1)
    || run.some(record => record.proof.backend === "deep-webgpu" && (record.proof.lightCount ?? 0) < 1)
    || new Set(deepResources).size !== 1) {
    throw new Error("Round-trip GPU fence, mapped-light, surface, or resource stability proof failed.");
  }
});
function tick(): void {
  if (closed) return;
  state.script.ticks++;
  if (!busy && coordinator) {
    const active = coordinator.active;
    if (active.backend instanceof DeepWebGpuBackend) active.backend.render(view(nativeCanvas(active)));
    else active.backend.render();
  }
  if (state.script.ticks % 15 === 0) updateMetrics();
  raf = requestAnimationFrame(tick);
}
window.addEventListener("pagehide", () => {
  closed = true; cancelAnimationFrame(raf); coordinator?.dispose(); deck.dispose();
  state.root.traverse(object => {
    if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); }
  });
}, { once: true });
window.addEventListener("error", event => fail(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => fail(event.reason));
void boot().then(() => { raf = requestAnimationFrame(tick); }).catch(fail);
