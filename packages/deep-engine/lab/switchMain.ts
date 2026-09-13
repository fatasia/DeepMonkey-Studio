import * as THREE from "three";
import { BackendPreferenceController, BackendSwitchCoordinator } from "../src/index.js";
import { BackendCanvasDeck, bindBackendCanvas, DeepWebGpuBackend, ThreeProjectionBridge,
  threeRenderView, type CanvasBoundBackend } from "../src/threeBridge/index.js";
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

const get = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing switch lab element: ${id}`);
  return value as T;
};
const status = get("switch-status"), select = get<HTMLSelectElement>("backend");
const runTwenty = get<HTMLButtonElement>("roundtrip"), canvasHost = get("canvas-host");
const initialCanvas = get<HTMLCanvasElement>("three-canvas");
const records: unknown[] = [], failures: string[] = [];
const state = createState();
const deck = new BackendCanvasDeck(domCanvasHost(canvasHost), "three", domCanvasSurface(initialCanvas));
let coordinator: BackendSwitchCoordinator<AuthorState, SwitchBackend>;
let preference: BackendPreferenceController<AuthorState, SwitchBackend>;
let busy = false, closed = false, raf = 0;

function createState(): AuthorState {
  const root = new THREE.Group(); root.name = "shared-author-root";
  const material = new THREE.MeshStandardMaterial({ color: 0xd59a3a, roughness: 0.34, metalness: 0.42 });
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.82, 0.26, 96, 16), material);
  mesh.name = "shared-knot"; root.add(mesh); root.updateWorldMatrix(true, true);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101820); scene.add(root);
  scene.add(new THREE.HemisphereLight(0xddeeff, 0x18202a, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 3.1); key.position.set(3, 5, 4); scene.add(key);
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
  return threeRenderView({ camera: state.camera, target: [0, 0, 0],
    width: Math.max(1, canvas.clientWidth || canvas.width),
    height: Math.max(1, canvas.clientHeight || canvas.height), pixelRatio: 1, extent: 3,
    background: [0.005, 0.009, 0.014], floor: [0.035, 0.045, 0.055], exposure: 1, roughness: 1 });
}

async function createBackend(id: string, _state: AuthorState, signal: AbortSignal): Promise<SwitchBackend> {
  const surface = deck.reserve(id);
  const canvas = (surface.canvas as DomCanvasSurface).native;
  try {
    const backend: InnerBackend = id === "three"
      ? await ThreeSwitchBackend.create(canvas, state.scene, state.camera, signal)
      : await DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu,
        projection: bridge(), root: state.root, view: view(canvas), signal });
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
  records.push({ target: id, result: result.status, active: coordinator.active.id,
    elapsedMs: performance.now() - started, revision: state.revision, scriptTicks: state.script.ticks,
    surfaces: deck.surfaceCount });
  if (result.status !== "applied" && result.status !== "unchanged") {
    throw new Error(result.snapshot.error ?? `Renderer switch ${result.status}.`);
  }
  if (deck.surfaceCount !== 1 || deck.active !== coordinator.active.surface) {
    throw new Error("Renderer surface ownership did not converge after publication.");
  }
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
  get("switch-diagnostics").textContent = JSON.stringify({ records, failures }, null, 2);
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
  for (let index = 0; index < 20; index++) {
    await choose(index % 2 === 0 ? "deep-webgpu" : "three");
  }
  if (state.root !== initialRoot || state.script !== initialScript) throw new Error("Round-trip replaced shared author state.");
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
