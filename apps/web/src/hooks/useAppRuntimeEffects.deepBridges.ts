import { useEffect, type MutableRefObject } from "react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { fingerprint64Labeled, getSceneModelAssetId } from "@bim-studio/contracts";
import type { HlodClusterStreamBinding } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { b4HlodClusterEnabled, StudioDeepWebGpuBridge } from "../viewer/StudioDeepWebGpuBridge";
import { StudioDeepWasmBridge } from "../viewer/StudioDeepWasmBridge";
import { compileStudioWasmRuntimePackage, normalizeStudioWasmModel } from "../viewer/studioWasmRuntimePackage";
import { compileSceneRenderPacket } from "../delivery/compileSceneRenderPacket";
import { describeDeepCompileNotice } from "../delivery/deepCompileNotice";
import { loadWebHlodPackage, type WebHlodPackage } from "../delivery/webHlodPackage";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { collectDeepOverlayPrimitives } from "../viewer/deepOverlayPrimitiveSource";
import { mergeDeepOverlayVertices } from "../viewer/deepOverlayPrimitives";
import { projectStudioEditorOverlay } from "../viewer/studioDeepEditorOverlay";
import { commitRendererPreference } from "../viewer/rendererBackendPreference";
import type { AppRuntimeEffectsContext, RendererRecoveryContext } from "./useAppRuntimeEffects.context";

interface DeepBridgeRefs {
  deepBridgeRef: MutableRefObject<StudioDeepWebGpuBridge | undefined>;
  wasmBridgeRef: MutableRefObject<StudioDeepWasmBridge | undefined>;
  deformationNoticeRef: MutableRefObject<string | undefined>;
  rendererRecoveryContextRef: MutableRefObject<RendererRecoveryContext>;
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
    showError,
    setRendererBackend,
    setRendererActiveBackend,
    setRendererSwitching,
    setRendererSwitchPhase,
    setRendererSwitchMessage,
    setMessage,
    rendererPreferenceCommitRef,
  } = context;
  const { deepBridgeRef, wasmBridgeRef, deformationNoticeRef, rendererRecoveryContextRef } = refs;
  useEffect(() => {
    if (!engine || !viewportRef.current) return;
    // 首帧编译缓存(P0-2):authorRenderPacket 每次后端切换都会被调用;场景快照与
    // 资产清单未变时直接复用上一次的 RenderPacket(packet 经 prepareRenderPacket
    // 校验后按只读消费,复用安全)。缓存容量 1:只保留最近一次编译,内存代价可控。
    // B4 簇级 HLOD:同一份编译的逐放置簇绑定随缓存共享,两个提供方顺序消费不打两次编译。
    let cachedPacket: { key: string; packet: RenderPacket; clusters?: readonly HlodClusterStreamBinding[] } | undefined;
    const compileAuthorScene = async (signal: AbortSignal) => {
      const latest = rendererRecoveryContextRef.current;
      const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
      const project = latest.project;
      if (!scene || !project) return undefined;
      const key = fingerprint64Labeled([
        ["scene", scene],
        ["assets", project.models.map((model) => ({ id: model.id, status: model.status,
          geometry: model.manifest?.geometryUrl ?? null }))],
      ]);
      if (cachedPacket?.key === key) return cachedPacket;
      const hlodPackages = b4HlodClusterEnabled() ? await loadSceneHlodPackages(scene, project.models, signal) : undefined;
      const compiled = await compileSceneRenderPacket(scene, {
        signal,
        // 编辑器逐帧把 Three AnimationMixer 的骨骼/形变姿态同步给 Deep,含蒙皮/形变目标的模型保留为活体。
        liveDeformation: true,
        // 4K 贴图合计超出引擎单资产解码预算时按需降采样;引擎导入子集之外的模型只隐藏并提示。
        textureBudgetBytes: 112 * 1024 * 1024,
        skipUndecodableModels: true,
        imageDecoder: browserImageDecoder,
        normalizeModel: normalizeStudioWasmModel,
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
      cachedPacket = { key, packet: compiled.packet, ...(compiled.hlodClusters ? { clusters: compiled.hlodClusters } : {}) };
      return cachedPacket;
    };
    const bridge = new StudioDeepWebGpuBridge(engine, viewportRef.current, {
      authorRenderPacket: async (signal) => (await compileAuthorScene(signal))?.packet,
      authorHlodClusters: async (signal) => (await compileAuthorScene(signal))?.clusters,
      onRuntimeFailure: (reason) => {
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
    let wasmOverlayRevision = 0;
    let wasmPreviousOverlay: Float32Array | undefined;
    const wasmBridge = new StudioDeepWasmBridge(engine, viewportRef.current, {
      readEditorOverlay: (width, height, pixelRatio) => {
        const vertices = mergeDeepOverlayVertices(
          projectStudioEditorOverlay(engine.getDeepEditorOverlayRoots(), engine.camera, width * pixelRatio, height * pixelRatio, pixelRatio),
          collectDeepOverlayPrimitives(engine, width, height, pixelRatio));
        if (wasmPreviousOverlay && wasmPreviousOverlay.length === vertices.length
          && wasmPreviousOverlay.every((value, index) => value === vertices[index])) {
          return { revision: wasmOverlayRevision, vertices: wasmPreviousOverlay };
        }
        wasmPreviousOverlay = vertices;
        return { revision: ++wasmOverlayRevision, vertices };
      },
      compilePackage: (signal) => {
        const latest = rendererRecoveryContextRef.current;
        const scene = latest.captureSceneSnapshot() ?? latest.activeScene;
        if (!scene || !latest.project) throw new Error("当前工作区没有可编译的场景或项目资源");
        return compileStudioWasmRuntimePackage(scene, latest.project, signal);
      },
      onRuntimeFailure: (reason) => {
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
    return () => {
      if (deepBridgeRef.current === bridge) deepBridgeRef.current = undefined;
      if (wasmBridgeRef.current === wasmBridge) wasmBridgeRef.current = undefined;
      wasmBridge.dispose();
      bridge.dispose();
    };
  }, [engine, showError]);
}
