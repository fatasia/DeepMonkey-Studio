import { useEffect, useRef, useState } from "react";
import type { PrimitiveKind } from "@bim-studio/contracts";
import * as THREE from "three";
import { ViewerEngine } from "../viewer/ViewerEngine";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { RendererBackend, SceneStatistics } from "../viewer/viewerTypes";
import { runtimeGpuDevice } from "../viewer/viewerRendererTypes";
import { shouldRecycleWebGpuRenderer, webGpuSceneReplacementThreshold } from "../viewer/webGpuRendererLifecyclePolicy";
import "./viewerVisualQa.css";
import { populateOcclusionVisualFixture } from "./occlusionVisualFixture";

interface ViewerQaState {
  backend: RendererBackend;
  ready: boolean;
  error?: string;
  startedAt: number;
  statistics?: SceneStatistics;
  performance?: FramePerformanceSnapshot;
  renderDemand?: ReturnType<ViewerEngine["getRenderDemandDiagnostics"]>;
  repeatedAssets?: ReturnType<ViewerEngine["getRepeatedAssetDiagnostics"]>;
  occlusion?: ReturnType<ViewerEngine["getOcclusionDiagnostics"]>;
  offscreen?: ReturnType<ViewerEngine["getOffscreenDiagnostics"]>;
  picking?: ReturnType<ViewerEngine["getPickingAccelerationDiagnostics"]>;
  sceneCycle?: number;
  deviceLossRecovery?: { message: string; recoveredBackend: RendererBackend; primitiveCount: number };
  rendererLifecycle?: { recycleCount: number; lastRecycledCycle?: number; lastRecycleDurationMs?: number };
}

interface ViewerQaControl {
  cycleScene: (cycle: number) => Promise<ViewerQaState>;
  rendererCacheDiagnostics: () => RendererCacheDiagnostics;
  retainedPrimitiveObjects: () => {
    tracked: number;
    alive: number;
    aliveByCycle: Record<string, number>;
    aliveByKind: Record<string, number>;
  };
  resetPerformanceSamples: () => void;
  simulateDeviceLoss: () => boolean;
  setOcclusion: (enabled: boolean) => void;
  setOffscreen: (enabled: boolean) => void;
}

interface RendererCacheDiagnostics {
  nodeBuilders?: number | undefined;
  pipelines?: number | undefined;
  vertexPrograms?: number | undefined;
  fragmentPrograms?: number | undefined;
  computePrograms?: number | undefined;
  uniformBuffers?: number | undefined;
  uniformBufferBytes?: number | undefined;
  bindGroupLayouts?: number | undefined;
  bindGroupLayoutUses?: number | undefined;
  renderObjectPasses?: string[] | undefined;
  renderListKeyLengths?: string[] | undefined;
}

declare global {
  interface Window {
    __viewerQa?: ViewerQaState;
    __viewerQaControl?: ViewerQaControl;
  }
}

const KINDS: PrimitiveKind[] = ["box", "sphere", "cylinder", "cone", "torus", "capsule"];
const COLORS = ["#d6a94c", "#54a994", "#557f9f", "#c86f63", "#8170aa", "#849059"];

export default function ViewerVisualQa() {
  const hostRef = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams(window.location.search);
  const requestedBackend = query.get("renderer") === "webgpu" ? "webgpu" : "webgl";
  const effectsEnabled = query.get("effects") !== "off";
  const effectVariant = query.get("effect") ?? "all";
  const repeatEffects = query.get("repeatEffects") === "true";
  const shadowsEnabled = query.get("shadows") !== "off";
  const batchingEnabled = query.get("batching") !== "off";
  const occlusionFixture = query.get("fixture") === "occlusion";
  const initialOcclusion = query.get("occlusion") === "on";
  const initialOffscreen = query.get("offscreen") === "on";
  const [occlusionEnabled, setOcclusionEnabled] = useState(initialOcclusion);
  const [offscreenEnabled, setOffscreenEnabled] = useState(initialOffscreen);
  const [cycling, setCycling] = useState(false);
  const cycleRef = useRef(0);
  const objectCount = Math.max(120, Math.min(5_000, Math.round(Number(query.get("objects")) || 120)));
  const [state, setState] = useState<ViewerQaState>({ backend: requestedBackend, ready: false, startedAt: performance.now() });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let engine: ViewerEngine | undefined;
    let timer: number | undefined;
    let deviceLossRecovery: ViewerQaState["deviceLossRecovery"];
    let sceneReplacementsSinceRendererCreated = 0;
    let recycleCount = 0;
    let lastRecycledCycle: number | undefined;
    let lastRecycleDurationMs: number | undefined;
    const primitiveRefs: Array<{ cycle: number; kind: PrimitiveKind; reference: WeakRef<THREE.Object3D> }> = [];
    let trackedPrimitiveCount = 0;
    const trackPrimitive = (cycle: number, object: THREE.Object3D, kind: PrimitiveKind) => {
      trackedPrimitiveCount += 1;
      primitiveRefs.push({ cycle, kind, reference: new WeakRef(object) });
    };

    const publish = () => {
      if (!engine) return window.__viewerQa;
      const next: ViewerQaState = {
        backend: engine.getRendererBackend(),
        ready: true,
        startedAt: state.startedAt,
        statistics: engine.getSceneStatistics(),
        performance: engine.getPerformanceSnapshot(),
        renderDemand: engine.getRenderDemandDiagnostics(),
        repeatedAssets: engine.getRepeatedAssetDiagnostics(),
        occlusion: engine.getOcclusionDiagnostics(),
        offscreen: engine.getOffscreenDiagnostics(),
        picking: engine.getPickingAccelerationDiagnostics(),
        sceneCycle: cycleRef.current,
        rendererLifecycle: {
          recycleCount,
          ...(lastRecycledCycle === undefined ? {} : { lastRecycledCycle }),
          ...(lastRecycleDurationMs === undefined ? {} : { lastRecycleDurationMs }),
        },
        ...(deviceLossRecovery ? { deviceLossRecovery } : {})
      };
      window.__viewerQa = next;
      setState(next);
      return next;
    };

    const configureEngine = (created: ViewerEngine, cycle = 0) => {
      engine = created;
      sceneReplacementsSinceRendererCreated = 0;
      created.setReadOnly(true);
      created.setRepeatedAssetBatchingEnabled(batchingEnabled);
      created.setOcclusionCullingEnabled(initialOcclusion);
      created.setOffscreenRenderingEnabled(initialOffscreen);
      created.setGlobalLighting({ ...created.getGlobalLighting(), shadowsEnabled });
      populateDeterministicScene(created, cycle, objectCount, effectsEnabled, effectVariant, repeatEffects, (object, kind) => trackPrimitive(cycle, object, kind));
      created.setCameraPose({ position: [19, 15, 19], target: [0, 1.8, 0], near: 0.1, far: 250, fov: 48 });
      if (occlusionFixture) { created.clearSceneModels(); populateOcclusionVisualFixture(created, objectCount, cycle); }
      created.select(undefined);
      created.selectAnnotation("qa-equipment-label");
      created.onRendererDeviceLost = (info) => {
        void (async () => {
          created.dispose();
          const fallback = await ViewerEngine.create(host, "webgl");
          if (disposed) { fallback.dispose(); return; }
          configureEngine(fallback);
          deviceLossRecovery = {
            message: info.message,
            recoveredBackend: fallback.getRendererBackend(),
            primitiveCount: fallback.getSceneStatistics().primitiveCount
          };
          publish();
        })().catch((reason: unknown) => {
          const next: ViewerQaState = { backend: "webgpu", ready: false, startedAt: state.startedAt, error: reason instanceof Error ? reason.message : String(reason) };
          window.__viewerQa = next;
          setState(next);
        });
      };
    };

    void ViewerEngine.create(host, requestedBackend).then((created) => {
      if (disposed) { created.dispose(); return; }
      configureEngine(created);
      publish();
      window.__viewerQaControl = {
        async cycleScene(cycle) {
          sceneReplacementsSinceRendererCreated += 1;
          const componentCount = engine?.getSceneStatistics().componentCount ?? 0;
          const replacementThreshold = webGpuSceneReplacementThreshold(componentCount);
          if (engine && shouldRecycleWebGpuRenderer(engine.getRendererBackend(), sceneReplacementsSinceRendererCreated, replacementThreshold)) {
            const recycleStartedAt = performance.now();
            const previous = engine;
            engine = undefined;
            previous.dispose();
            const replacement = await ViewerEngine.create(host, requestedBackend);
            if (disposed) {
              replacement.dispose();
              throw new Error("Viewer QA 已结束");
            }
            configureEngine(replacement, cycle);
            await waitForPipelineWarmup(replacement);
            replacement.resetPerformanceSamples();
            await waitForFrames(8);
            recycleCount += 1;
            lastRecycledCycle = cycle;
            lastRecycleDurationMs = performance.now() - recycleStartedAt;
          } else {
            engine?.clearSceneModels();
            if (engine) {
              if (occlusionFixture) populateOcclusionVisualFixture(engine, objectCount, cycle);
              else populateDeterministicScene(engine, cycle, objectCount, effectsEnabled, effectVariant, repeatEffects, (object, kind) => trackPrimitive(cycle, object, kind));
            }
          }
          await waitForFrames(4);
          return publish()!;
        },
        setOcclusion(enabled) { engine?.setOcclusionCullingEnabled(enabled); publish(); },
        setOffscreen(enabled) { engine?.setOffscreenRenderingEnabled(enabled); publish(); },
        retainedPrimitiveObjects() {
          const alive = primitiveRefs.filter(({ reference }) => reference.deref());
          primitiveRefs.splice(0, primitiveRefs.length, ...alive);
          return {
            tracked: trackedPrimitiveCount,
            alive: alive.length,
            aliveByCycle: countBy(alive, ({ cycle }) => String(cycle)),
            aliveByKind: countBy(alive, ({ kind }) => kind),
          };
        },
        rendererCacheDiagnostics() {
          return readRendererCacheDiagnostics(engine?.renderer);
        },
        resetPerformanceSamples() {
          engine?.resetPerformanceSamples();
        },
        simulateDeviceLoss() {
          if (!engine || engine.getRendererBackend() !== "webgpu") return false;
          const device = runtimeGpuDevice(engine.renderer);
          if (!device) return false;
          device.destroy();
          return true;
        },
      };
      timer = window.setInterval(publish, 500);
    }).catch((reason: unknown) => {
      const next: ViewerQaState = { backend: requestedBackend, ready: false, startedAt: state.startedAt, error: reason instanceof Error ? reason.message : String(reason) };
      window.__viewerQa = next;
      setState(next);
    });

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      engine?.dispose();
      delete window.__viewerQa;
      delete window.__viewerQaControl;
    };
  }, [effectsEnabled, objectCount, requestedBackend, shadowsEnabled, batchingEnabled, occlusionFixture, initialOcclusion, initialOffscreen]);

  return <main className="viewer-visual-qa" data-viewer-ready={state.ready} data-viewer-error={state.error ?? ""}>
    <div className="viewer-visual-qa-canvas" ref={hostRef} />
    <header>
      <span><small>PRODUCT BROWSER QA</small><strong>工业三维渲染基线</strong></span>
      <em>{state.backend.toUpperCase()}</em>
    </header>
    <output data-viewer-metrics>{JSON.stringify(state)}</output>
    <aside>
      <strong>{state.statistics?.primitiveCount ?? 0}</strong><span>确定性对象</span>
      <small>{state.performance ? `P95 ${state.performance.frameTimeMs.p95.toFixed(1)} ms · ${state.performance.renderer.drawCalls} draws` : state.error ?? "初始化中"}</small>
      <button disabled={!state.ready} onClick={() => window.__viewerQaControl?.resetPerformanceSamples()}>重置性能采样</button>
      <button disabled={!state.ready || cycling} onClick={() => {
        setCycling(true);
        void window.__viewerQaControl?.cycleScene(++cycleRef.current).catch(reason => setState(previous => ({ ...previous, error: String(reason) }))).finally(() => setCycling(false));
      }}>{cycling ? "切换中" : "切换场景"}</button>
      <button disabled={!state.ready} onClick={() => { setOcclusionEnabled(!occlusionEnabled); window.__viewerQaControl?.setOcclusion(!occlusionEnabled); }}>{occlusionEnabled ? "关闭遮挡剔除" : "开启遮挡剔除"}</button>
      <button disabled={!state.ready} onClick={() => { setOffscreenEnabled(!offscreenEnabled); window.__viewerQaControl?.setOffscreen(!offscreenEnabled); }}>{offscreenEnabled ? "关闭后台渲染" : "开启后台渲染"}</button>
      <button disabled={!state.ready || state.backend !== "webgpu"} onClick={() => window.__viewerQaControl?.simulateDeviceLoss()}>模拟设备丢失</button>
    </aside>
  </main>;
}

/** 仅 QA 页面读取 Three 内部缓存规模；字段不存在时静默降级，生产查看器不依赖私有 API。 */
function readRendererCacheDiagnostics(renderer: ViewerEngine["renderer"] | undefined): RendererCacheDiagnostics {
  if (!renderer) return {};
  const internal = renderer as unknown as {
    _nodes?: { nodeBuilderCache?: Map<unknown, unknown> };
    _pipelines?: {
      caches?: Map<unknown, unknown>;
      programs?: Record<"vertex" | "fragment" | "compute", Map<unknown, unknown>>;
    };
    _objects?: { chainMaps?: Record<string, unknown> };
    _renderLists?: { lists?: { weakMaps?: Record<string, unknown> } };
    backend?: {
      bindingUtils?: { _bindGroupLayoutCache?: Map<unknown, { usedTimes?: number }> };
    };
    info?: { memory?: { uniformBuffers?: number; uniformBuffersSize?: number } };
  };
  const layoutCache = internal.backend?.bindingUtils?._bindGroupLayoutCache;
  return {
    nodeBuilders: internal._nodes?.nodeBuilderCache?.size,
    pipelines: internal._pipelines?.caches?.size,
    vertexPrograms: internal._pipelines?.programs?.vertex.size,
    fragmentPrograms: internal._pipelines?.programs?.fragment.size,
    computePrograms: internal._pipelines?.programs?.compute.size,
    uniformBuffers: internal.info?.memory?.uniformBuffers,
    uniformBufferBytes: internal.info?.memory?.uniformBuffersSize,
    bindGroupLayouts: layoutCache?.size,
    bindGroupLayoutUses: layoutCache
      ? [...layoutCache.values()].reduce((total, layout) => total + (layout.usedTimes ?? 0), 0)
      : undefined,
    renderObjectPasses: Object.keys(internal._objects?.chainMaps ?? {}),
    renderListKeyLengths: Object.keys(internal._renderLists?.lists?.weakMaps ?? {}),
  };
}

function populateDeterministicScene(
  engine: ViewerEngine,
  cycle = 0,
  objectCount = 120,
  effectsEnabled = true,
  effectVariant = "all",
  repeatEffects = false,
  onPrimitive?: (object: THREE.Object3D, kind: PrimitiveKind) => void,
): void {
  engine.setSceneEnvironment({ gridVisible: true, backgroundColor: "#11191d", skybox: "none" });
  const columns = 12;
  for (let index = 0; index < objectCount; index += 1) {
    const kind = KINDS[index % KINDS.length]!;
    const x = (index % columns - (columns - 1) / 2) * 1.8;
    const z = (Math.floor(index / columns) - 4.5) * 1.8;
    const id = `qa-primitive-${index}`;
    // 场景循环只改变变换，不改变材质签名；否则验收夹具会人为制造无限材质/管线变体，
    // 无法区分真实资源泄漏与测试数据导致的缓存增长。
    const created = engine.createPrimitive(id, `验收对象 ${index + 1}`, kind, COLORS[index % COLORS.length]!, new THREE.Vector3(x, 0, z));
    onPrimitive?.(created.object, kind);
    engine.setModelTransform(id, { rotation: [0, index * 0.17 + cycle * 0.03, 0], scale: [0.55, 0.55 + index % 4 * 0.08, 0.55] });
  }
  // 固定高亮与工业标签用于双后端画质回归，避免只验证“能画出几何体”。
  const highlightedId = "qa-primitive-65";
  if (effectsEnabled && effectVariant !== "xray" && (cycle === 0 || repeatEffects)) {
    engine.setModelEffects(highlightedId, {
      ...engine.getModelEffects(highlightedId),
      outline: true,
      color: "#f0c763",
      intensity: 1.4
    });
  }
  // 半透明/XRay 可暴露双后端的排序、深度写入和混合差异，不能只比较不透明基础几何。
  const transparentId = "qa-primitive-66";
  if (effectsEnabled && effectVariant !== "outline" && (cycle === 0 || repeatEffects)) {
    engine.setModelEffects(transparentId, {
      ...engine.getModelEffects(transparentId),
      xray: true,
      color: "#55b9d0",
      intensity: 0.8
    });
  }
  engine.addAnnotation({
    id: "qa-equipment-label",
    name: "P-101 循环泵",
    description: "运行正常 · 72.4 °C",
    position: { x: 0.9, y: 2.3, z: 0.6 },
    color: "#5fbf93",
    visible: true,
    locked: true,
    size: 0.8,
    modelId: highlightedId
  });
  engine.selectAnnotation("qa-equipment-label");
}

async function waitForFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
}

/** 等待新设备完成当前场景的管线预热，再把稳定帧暴露给长稳门禁。 */
async function waitForPipelineWarmup(engine: ViewerEngine, maximumFrames = 180): Promise<void> {
  for (let frame = 0; frame < maximumFrames; frame += 1) {
    const status = engine.getPerformanceSnapshot().renderer.pipelineWarmup?.status;
    if (status === "ready" || status === "failed") return;
    await waitForFrames(1);
  }
}

function countBy<T>(values: T[], keyOf: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
