import { useEffect, useRef, type MutableRefObject } from "react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { getSceneModelAssetId } from "@bim-studio/contracts";
import { studioAuthorRenderPacketKey } from "../viewer/studioAuthorRenderPacketKey";
import type { HlodClusterStreamBinding } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { b4HlodClusterEnabled, StudioDeepWebGpuBridge } from "../viewer/StudioDeepWebGpuBridge";
import { StudioDeepWasmBridge } from "../viewer/StudioDeepWasmBridge";
import { StudioSceneCompilationCache } from "../viewer/StudioSceneCompilationCache";
import { clearStudioRendererPreparation, publishStudioRendererPreparation, readStudioRendererPreparation,
  startStudioRendererPrewarm } from "../viewer/studioRendererPreparation";
import { compileStudioWasmRuntimePackage, normalizeStudioWasmModel } from "../viewer/studioWasmRuntimePackage";
import { STUDIO_WASM_COMPILATION_LABELS } from "../viewer/studioWasmCompilationClient";
import { compileSceneRenderPacket } from "../delivery/compileSceneRenderPacket";
import { browserAuthorModelDecoder } from "../delivery/browserAuthorModelDecoder";
import { authorModelTransferBuffers } from "../delivery/authorModelTransfer";
import { describeDeepCompileNotice } from "../delivery/deepCompileNotice";
import { loadWebHlodPackage, type WebHlodPackage } from "../delivery/webHlodPackage";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { collectDeepOverlayPrimitives } from "../viewer/deepOverlayPrimitiveSource";
import { StudioDeepEditorOverlaySession } from "../viewer/StudioDeepEditorOverlaySession";
import { commitRendererPreference } from "../viewer/rendererBackendPreference";
import { isSceneAppearanceUnsupportedError } from "../delivery/sceneNeutralAppearance";
import type { AppRuntimeEffectsContext, RendererRecoveryContext } from "./useAppRuntimeEffects.context";

interface DeepBridgeRefs {
  deepBridgeRef: MutableRefObject<StudioDeepWebGpuBridge | undefined>;
  wasmBridgeRef: MutableRefObject<StudioDeepWasmBridge | undefined>;
  deformationNoticeRef: MutableRefObject<string | undefined>;
  rendererRecoveryContextRef: MutableRefObject<RendererRecoveryContext>;
  rendererSwitchOwnerRef: MutableRefObject<symbol | undefined>;
  wasmCompiledAuthorKeyRef: MutableRefObject<string | undefined>;
}
/**
 * B4 簇级 HLOD 包加载(opt-in):按场景资产去重,geometryUrl 同目录推导
 * `output/deep-package.json`;包缺失/非法即跳过该资产(退回原始几何),
 * 不阻塞其余资产的簇代理。
 */
async function loadSceneHlodPackages(scene: SceneSnapshot,
  models: ProjectRecord["models"], signal: AbortSignal): Promise<Map<string, WebHlodPackage>> {
  const packages = new Map<string, WebHlodPackage>();
  const assetIds = [...new Set(scene.models.map((model) => getSceneModelAssetId(model)))];
  await Promise.all(assetIds.map(async (assetId) => {
    const instance = scene.models.find((model) => getSceneModelAssetId(model) === assetId || model.modelId === assetId);
    const resolvedAssetId = instance ? getSceneModelAssetId(instance) : assetId;
    const model = models.find((candidate) => candidate.id === resolvedAssetId);
    const geometryUrl = model?.manifest?.geometryUrl;
    if (!model || !geometryUrl || model.status !== "ready") return;
    try {
      const base = new URL(geometryUrl, globalThis.location?.href ?? "http://localhost/");
      const packageUrl = new URL("deep-package.json", base).href;
      packages.set(assetId, await loadWebHlodPackage(packageUrl, async (url, loadSignal) =>
        new Uint8Array(await loadViewerAssetBuffer(url, model.name, { signal: loadSignal, timeoutMs: 120_000 })), signal));
    } catch {
      // 包缺失/路径非法/哈希不一致:该资产保持原几何渲染,不拖垮整场景编译。
    }
  }));
  return packages;
}

/** 引擎就绪后构建 Deep(WebGPU)与 Deep(WASM)两座候选后端桥,随引擎释放。 */
export function useDeepBridgesSetup(context: AppRuntimeEffectsContext, refs: DeepBridgeRefs): void {
  const {
    engine,
    viewportRef,
    setRendererBackend,
    setRendererActiveBackend,
    setRendererSwitching,
    setRendererSwitchPhase,
    setRendererSwitchMessage,
    setMessage,
    rendererPreferenceCommitRef,
  } = context;
  const { deepBridgeRef, wasmBridgeRef, deformationNoticeRef, rendererRecoveryContextRef, rendererSwitchOwnerRef, wasmCompiledAuthorKeyRef } = refs;
  const callbacks = useRef(context); callbacks.current = context;
  useEffect(() => {
    if (!engine || !viewportRef.current) return;
    const showError = (reason: unknown) => callbacks.current.showError(reason);
    // 首帧编译缓存(P0-2):authorRenderPacket 每次后端切换都会被调用;场景快照与
    // 资产清单未变时直接复用上一次的 RenderPacket(packet 经 prepareRenderPacket
    // 校验后按只读消费,复用安全)。缓存容量 1:只保留最近一次编译,内存代价可控。
    // packet 为 undefined 表示该场景指纹已降级为投影路径(外观超集),切换不再重编译。
    // B4 簇级 HLOD:同一份编译的逐放置簇绑定随缓存共享,两个提供方顺序消费不打两次编译。
    // 跨编译资产解码缓存(P0-2 同族):几何/变形解码按资产内容哈希在切换间复用,
    // 作者只改材质/变换时整段 GLB 解码跳过。decoded.packet 消费合同为只读
    // (prepareRenderPacket 校验后只读消费),跨编译共享安全;容量 4 个资产。
    const decodedAssetCache = new Map<string, { retainedBytes: number; decodedBytes: Uint8Array; decoded: Awaited<ReturnType<typeof import("@bim-studio/deep-engine/gltf").decodeDeformablePacketGlb>> }>();
    const decodedAssetCacheView = {
      get: (key: string) => {
        const hit = decodedAssetCache.get(key);
        if (hit) { decodedAssetCache.delete(key); decodedAssetCache.set(key, hit); } // LRU touch
        return hit;
      },
      set: (key: string, entry: { decodedBytes: Uint8Array; decoded: Awaited<ReturnType<typeof import("@bim-studio/deep-engine/gltf").decodeDeformablePacketGlb>> }) => {
        decodedAssetCache.delete(key);
        const retainedBytes = authorModelTransferBuffers(entry).reduce((total, buffer) => total + buffer.byteLength, 0);
        if (retainedBytes > 192 * 1024 * 1024) return;
        decodedAssetCache.set(key, { ...entry, retainedBytes });
        let totalBytes = [...decodedAssetCache.values()].reduce((total, cached) => total + cached.retainedBytes, 0);
        while (decodedAssetCache.size > 4 || totalBytes > 192 * 1024 * 1024) {
          const oldest = decodedAssetCache.keys().next().value!;
          totalBytes -= decodedAssetCache.get(oldest)!.retainedBytes;
          decodedAssetCache.delete(oldest);
        }
      },
    };
    let cachedPacket: { key: string; packet: RenderPacket | undefined; clusters?: readonly HlodClusterStreamBinding[] } | undefined;
    const authorCompilation = new StudioSceneCompilationCache<NonNullable<typeof cachedPacket> | undefined>();
    let appearanceNoticeKey: string | undefined;
    const compileAuthorSceneUncached = async (signal: AbortSignal) => {
      const latest = rendererRecoveryContextRef.current;
      const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
      const project = latest.project;
      if (!scene || !project) return undefined;
      const key = studioAuthorRenderPacketKey(scene, project.models);
      if (cachedPacket?.key === key) return cachedPacket;
      const hlodPackages = b4HlodClusterEnabled() ? await loadSceneHlodPackages(scene, project.models, signal) : undefined;
      try {
        const compiled = await compileSceneRenderPacket(scene, {
          signal,
          // 编辑器逐帧把 Three AnimationMixer 的骨骼/形变姿态同步给 Deep,含蒙皮/形变目标的模型保留为活体。
          liveDeformation: true,
          advancedMaterials: true,
          // 4K 贴图合计超出引擎单资产解码预算时按需降采样;作者贴图以同一数值作为整场预算,
          // 超限/不可解码 fail-closed 回退投影路径。引擎导入子集之外的模型只隐藏并提示。
          textureBudgetBytes: 112 * 1024 * 1024,
          skipUndecodableModels: true,
          imageDecoder: browserImageDecoder,
          normalizeModel: normalizeStudioWasmModel,
          ...(browserAuthorModelDecoder ? { decodeModel: browserAuthorModelDecoder } : {}),
          decodedAssetCache: decodedAssetCacheView,
          // 场景级贴图覆盖走 Deep 原生链:作者材质贴图 URL 由宿主取回字节、编译器解码进包,
          // 不再依赖 SceneAppearanceUnsupported 降级(该路径保留为兜底,见下方 catch)。
          loadTexture: async (url, loadSignal) => {
            loadSignal.throwIfAborted();
            return new Uint8Array(await loadViewerAssetBuffer(url, "材质贴图", { signal: loadSignal, timeoutMs: 120_000 }));
          },
          ...(hlodPackages?.size ? { hlodPackages } : {}),
          loadModel: async (assetId, loadSignal) => {
            loadSignal.throwIfAborted();
            const instance = scene.models.find((model) => getSceneModelAssetId(model) === assetId || model.modelId === assetId);
            const resolvedAssetId = instance ? getSceneModelAssetId(instance) : assetId;
            const model = project.models.find((candidate) => candidate.id === resolvedAssetId);
            const url = model?.manifest?.geometryUrl;
            if (!model || !url || model.status !== "ready") throw new Error(`Deep 编译缺少模型资源：${assetId}`);
            return new Uint8Array(await loadViewerAssetBuffer(url, model.name, { signal: loadSignal, timeoutMs: 120_000 }));
          },
        });
        signal.throwIfAborted();
        deformationNoticeRef.current = describeDeepCompileNotice(compiled);
        appearanceNoticeKey = undefined;
        cachedPacket = { key, packet: compiled.packet, ...(compiled.hlodClusters ? { clusters: compiled.hlodClusters } : {}) };
        return cachedPacket;
      } catch (reason) {
        // 取消与未知编译失败照旧向上传播(取消由候选事务静默,未知失败使切换失败并回 WebGL)。
        if (signal.aborted || !isSceneAppearanceUnsupportedError(reason)) throw reason;
        // 场景外观(材质贴图 URL、扩展效果)超出独立包编译语义:降级 Three 投影路径。
        // Deep 引擎保持激活(默认引擎不回退),作者材质已由 viewer 状态层挂好贴图,
        // 投影桥按槽位承接(map/emissive/normal/ao/metalnessRoughness);不支持的对象
        // 由投影器逐对象丢弃并记 issue,不再让整场切换失败。
        cachedPacket = { key, packet: undefined };
        deformationNoticeRef.current = undefined;
        if (appearanceNoticeKey !== key) {
          appearanceNoticeKey = key;
          setMessage(`场景含独立编译路径暂不支持的外观，已改用兼容投影在 Deep 下呈现：${reason instanceof Error ? reason.message : String(reason)}`);
        }
        return cachedPacket;
      }
    };
    const compileAuthorScene = (signal: AbortSignal) => {
      const latest = rendererRecoveryContextRef.current;
      const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
      if (!scene || !latest.project) return Promise.resolve(undefined);
      return authorCompilation.get(studioAuthorRenderPacketKey(scene, latest.project.models), signal, compileAuthorSceneUncached);
    };
    const bridge = new StudioDeepWebGpuBridge(engine, viewportRef.current, {
      authorPacketKey: () => {
        const latest = rendererRecoveryContextRef.current;
        const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
        return scene && latest.project ? studioAuthorRenderPacketKey(scene, latest.project.models) : undefined;
      },
      authorRenderPacket: async (signal) => (await compileAuthorScene(signal))?.packet,
      authorHlodClusters: async (signal) => (await compileAuthorScene(signal))?.clusters,
      onRuntimeFailure: (reason) => {
        rendererSwitchOwnerRef.current = undefined;
        rendererPreferenceCommitRef.current = "webgl";
        try { commitRendererPreference(rendererPreferenceCommitRef, "webgl"); }
        catch (error) { showError(error); }
        setRendererBackend("webgl");
        setRendererActiveBackend("webgl");
        setRendererSwitching(false);
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`Deep WebGPU 运行失败，已保留作者状态并回到 WebGL 2：${reason.message}`);
        setMessage("Deep WebGPU 运行失败，已回到 WebGL");
      },
    });
    const wasmOverlay = new StudioDeepEditorOverlaySession();
    // 编译前短路:作者指纹未变时直接复用上次 Worker 编译产物,不再重跑
    // 15 秒级编译(切换桥内的字节缓存随后 matches 命中,连 set 都跳过)。
    const wasmCompilation = new StudioSceneCompilationCache<Awaited<ReturnType<typeof compileStudioWasmRuntimePackage>>>();
    const wasmPackageKey = () => {
      const latest = rendererRecoveryContextRef.current;
      const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
      return scene && latest.project ? `${latest.project.id}:${studioAuthorRenderPacketKey(scene, latest.project.models)}` : undefined;
    };
    const compileWasmScene = (signal: AbortSignal) => {
      const latest = rendererRecoveryContextRef.current;
      const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
      if (!scene || !latest.project) throw new Error("当前工作区没有可编译的场景或项目资源");
      const key = `${latest.project.id}:${studioAuthorRenderPacketKey(scene, latest.project.models)}`;
      return wasmCompilation.get(key, signal, compileSignal => compileStudioWasmRuntimePackage(scene, latest.project!, compileSignal, { onProgress: progress => {
        if (compileSignal.aborted || rendererSwitchOwnerRef.current === undefined || callbacks.current.rendererBackend !== "wasm") return;
        callbacks.current.setRendererSwitchMessage(STUDIO_WASM_COMPILATION_LABELS[progress.stage]);
      } })).then(result => {
        signal.throwIfAborted();
        return result;
      });
    };
    const wasmBridge = new StudioDeepWasmBridge(engine, viewportRef.current, {
      readEditorOverlay: (width, height, pixelRatio) => {
        return wasmOverlay.read(engine.getDeepEditorOverlayRoots(), engine.camera, width, height, pixelRatio,
          collectDeepOverlayPrimitives(engine, width, height, pixelRatio));
      },
      compilePackage: compileWasmScene,
      packageKey: wasmPackageKey,
      onPackageAccepted: (compiled, key) => {
        wasmCompiledAuthorKeyRef.current = key;
        wasmCompilation.release(compiled);
      },
      onRuntimeFailure: (reason) => {
        rendererSwitchOwnerRef.current = undefined;
        rendererPreferenceCommitRef.current = "webgl";
        try { commitRendererPreference(rendererPreferenceCommitRef, "webgl"); }
        catch (error) { showError(error); }
        setRendererBackend("webgl");
        setRendererActiveBackend("webgl");
        setRendererSwitching(false);
        setRendererSwitchPhase("failed");
        setRendererSwitchMessage(`Deep WASM 运行失败，已保留作者状态并回到 WebGL 2：${reason.message}`);
        setMessage("Deep WASM 运行失败，已回到 WebGL");
      },
    });
    deepBridgeRef.current = bridge;
    wasmBridgeRef.current = wasmBridge;
    clearStudioRendererPreparation();
    const preparationProbe = () => readStudioRendererPreparation();
    const memoryProbe = () => ({ webgpuBytes: bridge.retainedGpuBytes, wasmBytes: wasmBridge.memoryBytes,
      decodedCacheBytes: [...decodedAssetCache.values()].reduce((sum, entry) => sum + entry.retainedBytes, 0) });
    const probeHost = window as unknown as { __studioRendererPreparationProbe?: typeof preparationProbe;
      __studioRendererMemoryProbe?: typeof memoryProbe };
    probeHost.__studioRendererPreparationProbe = preparationProbe;
    probeHost.__studioRendererMemoryProbe = memoryProbe;
    const stopPrewarm = startStudioRendererPrewarm(() => {
      const latest = rendererRecoveryContextRef.current;
      const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
      return scene && latest.project && (scene.models.length || scene.primitives.length)
        ? `${latest.project.id}:${studioAuthorRenderPacketKey(scene, latest.project.models)}` : undefined;
    }, async (key, signal) => {
      const startedAt = performance.now();
      const prepare = async (backend: "webgpu" | "wasm") => {
        publishStudioRendererPreparation(backend, { phase: "preparing", key, startedAt });
        let result;
        try { result = await (backend === "webgpu" ? bridge : wasmBridge).prewarm(signal); }
        catch (reason) {
          if (signal.aborted) return false;
          publishStudioRendererPreparation(backend, { phase: "failed", key, startedAt, finishedAt: performance.now(),
            error: reason instanceof Error ? reason.message : String(reason) });
          return true;
        }
        if (signal.aborted) return false;
        if (result.status === "cancelled") return false;
        publishStudioRendererPreparation(backend, { key, startedAt, finishedAt: performance.now(),
          phase: result.status === "failed" ? "failed" : "ready", ...(result.error ? { error: result.error } : {}) });
        return true;
      };
      const results = await Promise.allSettled([prepare("webgpu"), prepare("wasm")]);
      return results.every(result => result.status === "fulfilled" && result.value);
    });
    return () => {
      stopPrewarm();
      if (probeHost.__studioRendererPreparationProbe === preparationProbe) delete probeHost.__studioRendererPreparationProbe;
      if (probeHost.__studioRendererMemoryProbe === memoryProbe) delete probeHost.__studioRendererMemoryProbe;
      clearStudioRendererPreparation();
      authorCompilation.clear();
      wasmCompilation.clear();
      wasmOverlay.dispose();
      if (deepBridgeRef.current === bridge) deepBridgeRef.current = undefined;
      if (wasmBridgeRef.current === wasmBridge) wasmBridgeRef.current = undefined;
      wasmBridge.dispose();
      bridge.dispose();
    };
  }, [engine, viewportRef]);
}
