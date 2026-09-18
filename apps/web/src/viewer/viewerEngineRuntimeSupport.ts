import type { RendererLoadSnapshot } from "./framePerformanceMonitor";
import { canChangeRendererPixelRatio, shouldResizeRendererDrawingBuffer } from "./rendererResizePolicy";
import { normalizedRendererDrawCalls, type RendererInfoLike } from "./viewerEngineTypes";
import { ViewerEngineTimelineRuntime } from "./viewerEngineTimelineRuntime";
import { getPresentationPerformance } from "./viewerPresentationPerformance";

/** 渲染负载采样、分辨率和脚本常用视图操作。 */
export abstract class ViewerEngineRuntimeSupport extends ViewerEngineTimelineRuntime {
  /** 清空性能采样窗口；基准测试用它隔离显式 GC、初始化和稳定渲染阶段。 */
  resetPerformanceSamples(): void {
    this.framePerformanceMonitor.reset();
    getPresentationPerformance(this)?.reset();
  }

  protected resize(force = false): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (basePixelRatio !== this.adaptiveRenderScaleController.state().basePixelRatio) {
      this.adaptiveRenderScaleController.setBasePixelRatio(basePixelRatio);
      this.resetPerformanceSamples();
    }
    const pixelRatio = this.adaptiveRenderScaleController.state().pixelRatio;
    const pixelRatioChanged = Math.abs(this.renderer.getPixelRatio() - pixelRatio) >= 0.001;
    if (!force && !pixelRatioChanged && width === this.lastViewportWidth && height === this.lastViewportHeight) return;
    this.lastViewportWidth = width;
    this.lastViewportHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const policy = {
      backend: this.rendererBackend,
      drawingBufferInitialized: this.drawingBufferInitialized,
      shadowsEnabled: Boolean(this.lightingState?.enabled && this.lightingState.shadowsEnabled),
    };
    if (pixelRatioChanged && canChangeRendererPixelRatio(policy)) {
      this.renderer.setPixelRatio(pixelRatio);
      this.postProcessing?.setPixelRatio(pixelRatio);
    }
    if (force || shouldResizeRendererDrawingBuffer(policy)) {
      this.renderer.setSize(width, height, false);
      this.postProcessing?.setSize(width, height);
      this.drawingBufferInitialized = true;
    }
  }

  protected applyRendererPixelRatio(pixelRatio: number): void {
    if (Math.abs(this.renderer.getPixelRatio() - pixelRatio) < 0.001) return;
    if (!canChangeRendererPixelRatio({
      backend: this.rendererBackend,
      drawingBufferInitialized: this.drawingBufferInitialized,
      shadowsEnabled: Boolean(this.lightingState?.enabled && this.lightingState.shadowsEnabled),
    })) return;
    this.renderer.setPixelRatio(pixelRatio);
    this.postProcessing?.setPixelRatio(pixelRatio);
    this.resize(true);
  }

  protected applyShadowUpdatePolicy(): void {
    if (!("shadowMap" in this.renderer)) return;
    const shadowMap = this.renderer.shadowMap as { autoUpdate?: boolean; needsUpdate?: boolean };
    const manualCacheSupported =
      this.rendererBackend === "webgl" && "autoUpdate" in shadowMap && "needsUpdate" in shadowMap;
    const dynamicScene =
      this.sceneAnimationPlaying ||
      Boolean(this.physicsState.enabled && this.physicsState.playing) ||
      this.animationEnabledIds.size > 0;
    const decision = this.shadowUpdateGovernor.evaluate(
      Boolean(this.lightingState.enabled && this.lightingState.shadowsEnabled),
      dynamicScene,
      manualCacheSupported,
    );
    if (!manualCacheSupported) return;
    shadowMap.autoUpdate = decision.autoUpdate;
    if (decision.needsUpdate) shadowMap.needsUpdate = true;
  }

  protected readRendererLoad(): RendererLoadSnapshot {
    const presentation = getPresentationPerformance(this);
    if (presentation && this.presentationRendererBackend !== this.rendererBackend) return presentation.snapshot().renderer;
    const info = (this.renderer as unknown as { info?: RendererInfoLike }).info;
    const pipelineWarmup = this.pipelineWarmupScheduler.snapshot();
    const activeFeatures = [
      ...(this.postProcessing ? ["post-processing"] : []),
      ...(this.physicsState.enabled ? ["physics"] : []),
      ...(this.xrActive ? ["xr"] : []),
      ...(this.weatherMode !== "sunny" ? ["weather"] : []),
      ...(this.fragmentModels.size ? ["fragments"] : []),
      ...(this.adaptiveRenderScaleController.state().mode === "adaptive-fill-rate" ? ["adaptive-render-scale"] : []),
      ...(["scheduled", "running"].includes(pipelineWarmup.status) ? ["pipeline-warmup"] : []),
      ...(this.shadowUpdateGovernor.snapshot().mode === "cached" ? ["cached-shadows"] : []),
    ];
    return {
      backend: this.rendererBackend,
      drawCalls: normalizedRendererDrawCalls(this.rendererBackend, info?.render),
      triangles: info?.render?.triangles ?? 0,
      points: info?.render?.points ?? 0,
      lines: info?.render?.lines ?? 0,
      geometries: info?.memory?.geometries ?? 0,
      sharedPrimitiveGeometries: this.primitiveGeometryCache.size(),
      textures: info?.memory?.textures ?? 0,
      ...(info?.programs ? { programs: info.programs.length } : {}),
      viewportPixels: this.renderer.domElement.width * this.renderer.domElement.height,
      pixelRatio: this.renderer.getPixelRatio(),
      activeFeatures,
      adaptiveRenderScale: this.adaptiveRenderScaleController.state(),
      pipelineWarmup,
      shadowUpdates: this.shadowUpdateGovernor.snapshot(),
    };
  }

  setModelTransform(
    id: string,
    transform: {
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: [number, number, number];
    },
  ): boolean {
    const model = this.models.get(id);
    if (!model) return false;
    if (transform.position) model.object.position.fromArray(transform.position);
    if (transform.rotation) model.object.rotation.fromArray([...transform.rotation, model.object.rotation.order]);
    if (transform.scale) model.object.scale.fromArray(transform.scale);
    model.object.updateWorldMatrix(true, true);
    this.syncFragmentsTransformState(id);
    this.updateSelectionHelper();
    this.updateCollisions(true);
    this.markShadowMapDirty();
    this.onModelChange?.(model);
    return true;
  }

  setCameraPose(state: {
    position: [number, number, number];
    target: [number, number, number];
    near?: number;
    far?: number;
    fov?: number;
  }): void {
    this.applyCamera({
      ...this.getCameraState(),
      position: { x: state.position[0], y: state.position[1], z: state.position[2] },
      target: { x: state.target[0], y: state.target[1], z: state.target[2] },
    });
    if (state.near !== undefined || state.far !== undefined) {
      this.setCameraConstraints({
        ...this.cameraConstraints,
        nearClip: state.near ?? this.cameraConstraints.nearClip,
        farClip: state.far ?? this.cameraConstraints.farClip,
      });
    }
    if (state.fov === undefined) return;
    this.camera.fov = state.fov;
    this.camera.updateProjectionMatrix();
    this.emitCameraChange(true);
  }

  focusModel(id: string, layerId?: string): boolean {
    const model = this.models.get(id);
    if (!model) return false;
    this.focusObject(layerId ? this.layerObjects.get(id)?.get(layerId) ?? model.object : model.object);
    return true;
  }
}
