import * as THREE from "three";
import type { ClippingGroup } from "three/webgpu";
import { type RendererBackend } from "./viewerTypes";
import { ViewerEnginePointer } from "./viewerEnginePointer";
import { bindViewerPerformancePreferences } from "./viewerPerformanceBinding";
import { normalizeRendererDeviceLoss, runtimeGpuDevice, type RendererInstance, type WebGpuRendererWithLossHandler } from "./viewerRendererTypes";

export type { CollisionRecord, ComponentFacets, ComponentFilter, ComponentRecord } from "./analysis";
export {
  ModelLoadSupersededError,
  shouldRenderSceneLightProxy,
  type BimPropertyEntry,
  type BimSpaceRecord,
  type InteractionEventDetail,
  type InteractionScriptResult,
  type LayerTreeNode,
  type LoadedSceneModel,
  type MeasureMode,
  type NavigationCollisionDiagnostics,
  type NavigationMode,
  type PointerInfo,
  type RendererBackend,
  type SceneStatistics,
  type SelectionScope,
  type StandardView,
  type TransformMode,
} from "./viewerTypes";
export { normalizedSpaceBox } from "./sceneObjectUtils";

/** 面向工作区的稳定查看器 API；内部能力按职责拆分，避免单体引擎继续膨胀。 */
export class ViewerEngine extends ViewerEnginePointer {
  private constructor(container: HTMLElement, renderer: RendererInstance, backend: RendererBackend, modelRoot: THREE.Group | ClippingGroup) {
    super(container, renderer, backend, modelRoot);
    bindViewerPerformancePreferences(this);
    this.startRuntime();
  }

  static async create(container: HTMLElement, requestedBackend: RendererBackend = "webgl"): Promise<ViewerEngine> {
    if (requestedBackend === "webgpu") {
      if (!("gpu" in navigator)) throw new Error("当前浏览器或显卡不支持 WebGPU");
      const { ClippingGroup, WebGPURenderer } = await import("three/webgpu");
      const renderer = new WebGPURenderer({ antialias: true, powerPreference: "high-performance", trackTimestamp: true });
      try {
        await renderer.init();
        if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
          throw new Error("WebGPU 初始化失败，已回退 WebGL");
        }
        const engine = new ViewerEngine(container, renderer, "webgpu", new ClippingGroup());
        const webGpuRenderer = renderer as WebGpuRendererWithLossHandler;
        const device = runtimeGpuDevice(renderer);
        // Three.js 默认只输出错误；产品层接管设备丢失并恢复到 WebGL。
        webGpuRenderer.onDeviceLost = (info) => engine.notifyRendererDeviceLost(normalizeRendererDeviceLoss(info));
        // Three.js 会忽略 reason=destroyed。直接监听 GPUDevice 才能覆盖浏览器主动回收等完整故障路径，
        // ViewerEngine.dispose 会先设置销毁标记，因此正常切换渲染器不会误触发恢复。
        void device?.lost.then((info) => engine.notifyRendererDeviceLost(normalizeRendererDeviceLoss(info)));
        return engine;
      } catch (error) {
        renderer.dispose();
        throw error;
      }
    }
    return new ViewerEngine(container, new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" }), "webgl", new THREE.Group());
  }
}
