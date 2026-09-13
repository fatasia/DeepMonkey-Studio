import * as THREE from "three";
import { ViewerEngineNavigationTools } from "./viewerEngineNavigationTools";
import { disposeViewerDeviceSignals } from "./viewerDeviceSignals";
import { closeSharedGltfPool } from "./sharedGltfAssets";
import { disposeGltfKtx2 } from "./gltfKtx2Support";
import { disposeOrdinaryPicking } from "./ordinaryPicking";
import { disposeViewerPerformanceBinding } from "./viewerPerformanceBinding";

/** 集中释放浏览器事件、Worker、物理世界和 GPU 资源。 */
export abstract class ViewerEngineLifecycle extends ViewerEngineNavigationTools {
  dispose(): void {
    if (this.rendererDisposalStarted) return;
    this.rendererDisposalStarted = true;
    disposeViewerPerformanceBinding(this);
    disposeOrdinaryPicking(this);
    this.offscreen.dispose();
    this.releaseOcclusionFilter?.();
    this.conservativeOcclusion.dispose();
    this.repeatedAssetBatcher.dispose();
    closeSharedGltfPool(this);
    disposeViewerDeviceSignals(this);
    this.materialActivity.dispose();
    for (const event of this.renderInputEvents) window.removeEventListener(event, this.renderWake, { capture: true });
    document.removeEventListener("visibilitychange", this.renderWake);
    cancelAnimationFrame(this.animationFrame);
    for (const cancel of this.visibilityTransitionCancels.values()) cancel();
    this.visibilityTransitionCancels.clear();
    if (this.resizeAnimationFrame !== 0) cancelAnimationFrame(this.resizeAnimationFrame);
    this.resizeAnimationFrame = 0;
    this.framePerformanceMonitor.reset();
    this.pipelineWarmupScheduler.dispose();
    this.longTaskMonitor.dispose();
    this.gpuFrameTimeMonitor.dispose();
    this.resizeObserver.disconnect();
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.removeEventListener("contextmenu", this.handleContextMenu);
    this.renderer.domElement.removeEventListener("dblclick", this.handleDoubleClick);
    this.orbit.dispose();
    this.pointer.disconnect();
    this.transform.dispose();
    this.dracoLoader.dispose();
    disposeGltfKtx2(this.gltfLoader);
    this.clearSceneModels();
    this.disposeAllSpatialAudio();
    this.primitiveGeometryCache.dispose();
    this.primitiveMaterialCache.dispose();

    // 环境辅助网格不属于场景模型，必须单独释放，避免反复创建 Viewer 时泄漏 GPU 资源。
    if (this.gridHelper) {
      this.disposeObject(this.gridHelper);
      this.gridHelper = undefined;
    }
    if (this.groundHelper) {
      this.disposeObject(this.groundHelper);
      this.groundHelper = undefined;
    }
    const fragments = this.fragments;
    this.fragments = undefined;
    this.importer = undefined;
    this.fragmentApi = undefined;
    // Fragments 自带 Worker 池，切换场景时必须显式终止后台线程。
    void fragments?.dispose().catch(() => undefined);
    for (const source of this.materialTextureSources.values()) {
      void source.then((texture) => texture.dispose()).catch(() => undefined);
    }
    this.materialTextureSources.clear();
    this.collisionMaterial.dispose();
    this.disposeWeatherEffect();
    this.skyboxTextures.forEach((texture) => texture.dispose());
    this.skyboxTextures.clear();
    this.externalEnvironmentTexture?.dispose();
    this.disposeClippingHelper();
    this.clearNavigationCollisionDebug();
    this.navigationCollisionDebugGroup.removeFromParent();
    if (this.cameraPathHelper) this.disposeObject(this.cameraPathHelper);
    this.removeSelectionHelper();
    this.clearAnnotations(false);
    for (const visual of this.spaceVisuals.values()) this.disposeObject(visual.object);
    this.spaceVisuals.clear();
    this.disposeSceneLightProxies();
    this.physicsWorld?.free();
    this.physicsWorld = undefined;
    this.rapier = undefined;
    this.postProcessingRevision += 1;
    if (this.postProcessingDisposeTimer !== undefined) window.clearTimeout(this.postProcessingDisposeTimer);
    this.postProcessingDisposeTimer = undefined;
    this.postProcessing?.dispose();
    this.postProcessing = undefined;
    this.gpuResourceRetirementQueue.dispose();
    this.renderer.dispose();
    if (this.rendererBackend === "webgl") (this.renderer as THREE.WebGLRenderer).forceContextLoss();
    this.renderer.domElement.remove();
  }
}
