import * as THREE from "three";
import type {
  DataMessage,
  IndustrialPrefabInstanceState,
  IndustrialPrefabRuntimeAction,
  SceneAnnotationState,
  SceneInteractionScriptState,
  SceneInteractionActionState,
  SceneInteractionTarget,
  SceneInteractionTrigger,
  SceneModelAnimationPlaybackState,
  SceneVisualTransitionState,
} from "@bim-studio/contracts";
import { isVectorValue } from "./bimMetadata";
import { normalizeAnnotation, sameRuntimeInteractionTarget } from "./viewerStateUtils";
import { createAnnotationVisual } from "./sceneOverlayVisuals";
import { type FramePerformanceSnapshot } from "./framePerformanceMonitor";
import { createStudioViewerAPI } from "../studio/studioApi";
import { type InteractionEventDetail, type LoadedSceneModel, type RendererBackend, type SceneStatistics } from "./viewerTypes";
import type { RendererInstance } from "./viewerRendererTypes";
import { readHeapSnapshot } from "./viewerHeapSnapshot";
import { normalizeVisualTransition, visibilityTransitionSample } from "./visibilityTransition";
import { ViewerEngineCore } from "./viewerEngineCore";
import { buildMotionRoutePlan, sampleMotionRoute, type MotionRouteSample } from "../prefabs/motionRoutePlayer";
import { mergeModelEffectsPatch, type ModelEffectsPatch } from "./modelEffectState";
import { normalizeMaterialDataPatch } from "./materialDataPatch";
import { applyViewerDeviceSignal } from "./viewerDeviceSignals";
import { annotationLocalAnchor, annotationWorldAnchor } from "./annotationAnchor";
import { clearIndustrialPrefabProxy, ensureIndustrialPrefabProxy } from "./industrialPrefabProxy";
import { detachSharedGltfResources } from "./sharedGltfAssets";

/** Interaction 职责层。 */
export abstract class ViewerEngineInteraction extends ViewerEngineCore {
  getRendererBackend(): RendererBackend {
    return this.rendererBackend;
  }
  /** 保留旧 API 名称兼容已发布数据，实际语义为自动质量守卫。 */
  setFastRuntime(enabled: boolean): void {
    this.adaptiveQualityEnabled = enabled;
    const restoredPixelRatio = this.adaptiveRenderScaleController.setEnabled(enabled);
    this.framePerformanceMonitor.reset();
    if (restoredPixelRatio !== undefined) this.applyRendererPixelRatio(restoredPixelRatio);
  }
  listModels(): LoadedSceneModel[] {
    return [...this.models.values()];
  }
  /** Trusted script escape hatches. Prefer the stable studio API for ordinary work. */
  getRawObject(modelId: string): THREE.Object3D | undefined {
    const object = this.models.get(modelId)?.object;
    if (object) detachSharedGltfResources(object);
    return object;
  }
  getRawScene(): THREE.Scene {
    for (const model of this.models.values()) detachSharedGltfResources(model.object);
    return this.scene;
  }
  getRawCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
  getRawRenderer(): RendererInstance {
    return this.renderer;
  }
  setInteractionScripts(scripts: SceneInteractionScriptState[]): void {
    this.interactionScripts = scripts.map((script) => ({
      ...script,
      target: { ...script.target },
      ...(script.actions ? { actions: script.actions.map((action) => ({ ...action })) } : {}),
    }));
  }
  getInteractionScripts(): SceneInteractionScriptState[] {
    return this.interactionScripts.map((script) => ({
      ...script,
      target: { ...script.target },
      ...(script.actions ? { actions: script.actions.map((action) => ({ ...action })) } : {}),
    }));
  }
  dispatchInteraction(trigger: SceneInteractionTrigger, target: SceneInteractionTarget, detail: InteractionEventDetail = {}): void {
    const targets = target.kind === "object" && target.layerId ? [{ kind: "object", modelId: target.modelId } as SceneInteractionTarget, target] : [target];
    for (const currentTarget of targets) this.dispatchExactInteraction(trigger, currentTarget, detail);
  }
  protected dispatchExactInteraction(trigger: SceneInteractionTrigger, target: SceneInteractionTarget, detail: InteractionEventDetail = {}): void {
    this.onInteractionTrigger?.(trigger, structuredClone(target));
    for (const script of this.interactionScripts) {
      if (!script.enabled || script.trigger !== trigger || !sameRuntimeInteractionTarget(script.target, target)) continue;
      void this.runInteractionScript(script, detail);
    }
  }
  protected dispatchObjectLifecycle(trigger: "load" | "animationStart" | "animationEnd", modelId: string): void {
    const targets = new Map<string, SceneInteractionTarget>();
    targets.set("model", { kind: "object", modelId });
    for (const script of this.interactionScripts) {
      if (!script.enabled || script.trigger !== trigger || script.target.kind !== "object" || script.target.modelId !== modelId) continue;
      targets.set(script.target.layerId ?? "model", script.target);
    }
    for (const target of targets.values()) this.dispatchExactInteraction(trigger, target);
  }
  async runInteractionScript(script: SceneInteractionScriptState, detail: InteractionEventDetail = { test: true }): Promise<void> {
    const startedAt = performance.now();
    try {
      // 旧版 ctx.scene / objects 合同允许直接改 Three 几何，进入可信脚本前隔离共享资源。
      for (const model of this.models.values()) detachSharedGltfResources(model.object);
      const target = this.interactionTargetContext(script.target, detail);
      const context = {
        trigger: script.trigger,
        target,
        event: {
          type: script.trigger,
          test: detail.test ?? false,
          originalEvent: detail.originalEvent,
          point: detail.point,
          object: detail.object,
          payload: detail.payload,
          timestamp: new Date().toISOString(),
        },
        engine: this,
        scene: this.scene,
        camera: this.camera,
        renderer: this.renderer,
        controls: { orbit: this.orbit, pointer: this.pointer, transform: this.transform },
        objects: {
          models: this.models,
          annotations: this.annotations,
          lights: this.sceneLights,
          lightTargets: this.sceneLightTargets,
          layers: this.layerObjects,
          fragments: this.fragmentModels,
          spaces: this.spaceVisuals,
        },
      };
      for (const action of script.actions ?? []) {
        if (action.enabled) await this.runInteractionAction(script.target, action);
      }
      const AsyncFunction = Object.getPrototypeOf(async function () {
        /* trusted scene script */
      }).constructor as new (...arguments_: string[]) => (...values: unknown[]) => Promise<unknown>;
      const studio = createStudioViewerAPI(this, {
        emitAction: (action) => {
          const normalized = { ...action, id: crypto.randomUUID(), enabled: true } as SceneInteractionActionState;
          void this.runInteractionAction(script.target, normalized);
        },
      });
      const execute = new AsyncFunction("ctx", "studio", "THREE", "engine", `"use strict";\n${script.code}\n//# sourceURL=bim-studio-event-${script.id}.js`);
      await execute(context, studio, THREE, this);
      this.onInteractionScriptResult?.({ script, status: "success", durationMs: performance.now() - startedAt, ...(detail.test ? { test: true } : {}) });
    } catch (error) {
      console.error(`场景事件“${script.name}”执行失败`, error);
      this.onInteractionScriptResult?.({ script, status: "error", durationMs: performance.now() - startedAt, error, ...(detail.test ? { test: true } : {}) });
    }
    // 可信脚本允许直接访问 Three.js 对象；脚本返回后统一刷新静态阴影缓存。
    this.markShadowMapDirty();
  }
  executeInteractionAction(target: SceneInteractionTarget, action: SceneInteractionActionState): Promise<void> {
    return this.runInteractionAction(target, action);
  }
  getIndustrialPrefabState(modelId: string): IndustrialPrefabInstanceState | undefined {
    const state = this.modelPrefabStates.get(modelId);
    return state ? structuredClone(state) : undefined;
  }
  setIndustrialPrefabState(modelId: string, state: IndustrialPrefabInstanceState | undefined): void {
    const model = this.models.get(modelId);
    if (!model) return;
    const previousState = this.modelPrefabStates.get(modelId);
    const previousRuntime = this.motionRouteRuntimes.get(modelId);
    this.motionRouteRuntimes.delete(modelId);
    if (!state) {
      this.modelPrefabStates.delete(modelId);
      if (clearIndustrialPrefabProxy(model.object)) {
        this.rebuildComponentIndex(modelId);
        this.markShadowMapDirty();
      }
      return;
    }
    const next = structuredClone(state);
    this.modelPrefabStates.set(modelId, next);
    if (ensureIndustrialPrefabProxy(model.object, next.kind)) {
      this.rebuildComponentIndex(modelId);
      this.markShadowMapDirty();
    }
    const route = next.motionRoute;
    if (!route) return;
    const plan = buildMotionRoutePlan(route);
    if (!plan) return;
    const routeUnchanged = Boolean(previousRuntime && previousState?.motionRoute && JSON.stringify(previousState.motionRoute) === JSON.stringify(route));
    const elapsedSeconds = routeUnchanged ? previousRuntime!.elapsedSeconds : Math.max(0, route.startOffsetSeconds);
    const sample = sampleMotionRoute(plan, elapsedSeconds);
    this.motionRouteRuntimes.set(modelId, {
      plan,
      elapsedSeconds,
      ...(sample.lastArrival ? { lastArrivalToken: sample.lastArrival.token } : {}),
    });
    // 运行中或暂停中的快照需要恢复确定位置；空闲对象保持作者摆放位置。
    if (next.operatingState === "running" || next.operatingState === "paused") this.applyIndustrialMotionSample(modelId, sample, route.orientToPath);
  }
  executeIndustrialPrefabAction(modelId: string, action: IndustrialPrefabRuntimeAction): void {
    const current = this.modelPrefabStates.get(modelId);
    if (!current) throw new Error("目标对象不是工业预制体实例");
    if (action === "clear-fault") {
      const next = { ...current, operatingState: "idle" as const };
      delete next.faultCode;
      this.setIndustrialOperatingState(modelId, next);
      return;
    }
    const runtime = this.motionRouteRuntimes.get(modelId);
    if (!current.motionRoute || !runtime) throw new Error("目标预制体尚未配置可运行路线");
    if (action === "pause") this.setIndustrialOperatingState(modelId, { ...current, operatingState: "paused" });
    else if (action === "stop") this.setIndustrialOperatingState(modelId, { ...current, operatingState: "idle" });
    else if (action === "resume") this.setIndustrialOperatingState(modelId, { ...current, operatingState: "running" });
    else {
      runtime.elapsedSeconds = action === "dispatch" ? Math.max(0, current.motionRoute.startOffsetSeconds) : 0;
      const initialArrival = sampleMotionRoute(runtime.plan, runtime.elapsedSeconds).lastArrival;
      if (initialArrival) runtime.lastArrivalToken = initialArrival.token;
      else delete runtime.lastArrivalToken;
      const operatingState = action === "return" ? "idle" : "running";
      this.setIndustrialOperatingState(modelId, { ...current, operatingState });
      this.applyIndustrialMotionSample(modelId, sampleMotionRoute(runtime.plan, runtime.elapsedSeconds), current.motionRoute.orientToPath);
    }
  }
  protected updateIndustrialMotionRoutes(deltaSeconds: number): void {
    for (const [modelId, runtime] of this.motionRouteRuntimes) {
      const prefab = this.modelPrefabStates.get(modelId);
      if (!prefab?.motionRoute || prefab.operatingState !== "running") continue;
      runtime.elapsedSeconds += Math.max(0, deltaSeconds);
      const sample = sampleMotionRoute(runtime.plan, runtime.elapsedSeconds);
      this.applyIndustrialMotionSample(modelId, sample, prefab.motionRoute.orientToPath);
      if (sample.lastArrival && sample.lastArrival.token !== runtime.lastArrivalToken) {
        runtime.lastArrivalToken = sample.lastArrival.token;
        const payload = { modelId, pointId: sample.lastArrival.pointId, elapsedSeconds: runtime.elapsedSeconds };
        this.dispatchInteraction("routePointReached", { kind: "object", modelId }, { payload });
        window.dispatchEvent(new CustomEvent("bim-studio:route-point-reached", { detail: payload }));
      }
      if (sample.completed) this.setIndustrialOperatingState(modelId, { ...prefab, operatingState: "idle" });
    }
  }
  private applyIndustrialMotionSample(modelId: string, sample: MotionRouteSample, orientToPath: boolean): void {
    const model = this.models.get(modelId);
    if (!model) return;
    model.object.position.set(sample.position.x, sample.position.y, sample.position.z);
    if (orientToPath && Math.hypot(sample.direction.x, sample.direction.z) > 1e-6) {
      model.object.rotation.y = Math.atan2(sample.direction.x, sample.direction.z);
    }
    model.object.updateWorldMatrix(true, true);
    this.syncFragmentsTransformState(modelId);
    this.markShadowMapDirty();
  }
  private setIndustrialOperatingState(modelId: string, state: IndustrialPrefabInstanceState): void {
    this.modelPrefabStates.set(modelId, structuredClone(state));
    const model = this.models.get(modelId);
    if (model) this.onModelChange?.(model);
    window.dispatchEvent(new CustomEvent("bim-studio:prefab-state-change", { detail: { modelId, state: structuredClone(state) } }));
  }
  protected async runInteractionAction(target: SceneInteractionTarget, action: SceneInteractionActionState): Promise<void> {
    if (action.type === "openUrl") {
      const url = action.url?.trim();
      if (!url) throw new Error("打开网页动作缺少 URL");
      if (!/^(https?:\/\/|\/)/i.test(url)) throw new Error("网页地址必须以 http://、https:// 或 / 开头");
      if (action.newTab !== false) window.open(url, "_blank", "noopener,noreferrer");
      else window.location.assign(url);
      return;
    }
    if (["navigateScene", "cameraView", "message", "dashboard", "setData"].includes(action.type)) {
      window.dispatchEvent(new CustomEvent("bim-studio:interaction-action", { detail: structuredClone(action) }));
      return;
    }
    const objectTarget = action.target ?? (target.kind === "object" ? target : undefined);
    if (!objectTarget) throw new Error(`动作 ${action.type} 缺少目标三维对象`);
    if (action.type === "focus") {
      this.applySceneDataMessage({ source: "interaction", key: "focus", value: true, timestamp: new Date().toISOString(), target: objectTarget, action: "focus" });
      return;
    }
    if (action.type === "prefabAction") {
      if (!action.prefabAction) throw new Error("工业预制体动作缺少控制方式");
      this.executeIndustrialPrefabAction(objectTarget.modelId, action.prefabAction);
      return;
    }
    if (action.type === "visibility") {
      const current = objectTarget.layerId
        ? (this.fragmentLayers.get(objectTarget.modelId)?.get(objectTarget.layerId)?.node.visible ??
          this.layerObjects.get(objectTarget.modelId)?.get(objectTarget.layerId)?.visible ??
          true)
        : (this.models.get(objectTarget.modelId)?.visible ?? true);
      const visible = action.value === "show" ? true : action.value === "hide" ? false : !current;
      await this.runVisibilityTransition(objectTarget, visible, action.transition);
      return;
    }
    if (action.type === "color") {
      const color = typeof action.value === "string" ? action.value : "#ff4057";
      if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("颜色必须是 #RRGGBB 格式");
      this.applySceneDataMessage({ source: "interaction", key: "color", value: color, timestamp: new Date().toISOString(), target: objectTarget, action: "color" });
      return;
    }
    if (action.type === "opacity") {
      const opacity = THREE.MathUtils.clamp(Number(action.value ?? 1), 0, 1);
      this.applySceneDataMessage({ source: "interaction", key: "opacity", value: opacity, timestamp: new Date().toISOString(), target: objectTarget, action: "opacity" });
      return;
    }
    if (action.type === "animation") {
      const current = this.isAnimationEnabled(objectTarget.modelId);
      const enabled = action.value === "play" ? true : action.value === "stop" ? false : !current;
      this.applySceneDataMessage({ source: "interaction", key: "animation", value: enabled, timestamp: new Date().toISOString(), target: objectTarget, action: "animation" });
    }
  }

  protected runVisibilityTransition(
    target: { kind: "object"; modelId: string; layerId?: string },
    visible: boolean,
    requested: SceneVisualTransitionState | undefined,
  ): Promise<void> {
    const transition = normalizeVisualTransition(requested);
    const model = this.models.get(target.modelId);
    const unsupportedTarget = Boolean(target.layerId || this.fragmentModels.has(target.modelId));
    if (!model || transition.kind === "none" || transition.durationMs <= 0 || unsupportedTarget) {
      this.applyVisibilityMessage(target, visible);
      return Promise.resolve();
    }

    const key = target.modelId;
    this.visibilityTransitionCancels.get(key)?.();
    const object = model.object;
    const baseOpacity = model.opacity;
    const basePosition = object.position.clone();
    const baseScale = object.scale.clone();
    const bounds = new THREE.Box3().setFromObject(object);
    const riseDistance = bounds.isEmpty()
      ? 0.6
      : THREE.MathUtils.clamp(bounds.getSize(new THREE.Vector3()).y * 0.08, 0.2, 2);
    if (visible) this.applyVisibilityMessage(target, true);

    return new Promise((resolve) => {
      const startedAt = performance.now();
      let frame = 0;
      let settled = false;
      const restore = () => {
        this.setObjectOpacity(object, baseOpacity);
        object.position.copy(basePosition);
        object.scale.copy(baseScale);
        object.updateMatrixWorld(true);
      };
      const finish = (applyTarget: boolean) => {
        if (settled) return;
        settled = true;
        if (frame) cancelAnimationFrame(frame);
        restore();
        if (applyTarget && !visible) this.applyVisibilityMessage(target, false);
        if (this.visibilityTransitionCancels.get(key) === cancel) this.visibilityTransitionCancels.delete(key);
        this.markShadowMapDirty();
        resolve();
      };
      const cancel = () => finish(false);
      this.visibilityTransitionCancels.set(key, cancel);
      const tick = (now: number) => {
        if (settled) return;
        const progress = Math.min(1, (now - startedAt) / transition.durationMs);
        const sample = visibilityTransitionSample(transition, progress, visible);
        this.setObjectOpacity(object, baseOpacity * sample.opacityFactor);
        object.scale.copy(baseScale).multiplyScalar(sample.scaleFactor);
        object.position.copy(basePosition).addScaledVector(this.camera.up, riseDistance * sample.riseFactor);
        object.updateMatrixWorld(true);
        if (progress >= 1) finish(true);
        else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
  }

  private applyVisibilityMessage(target: { kind: "object"; modelId: string; layerId?: string }, visible: boolean): void {
    this.applySceneDataMessage({
      source: "interaction",
      key: "visibility",
      value: visible,
      timestamp: new Date().toISOString(),
      target,
      action: "visibility",
    });
  }
  protected interactionTargetContext(target: SceneInteractionTarget, detail: InteractionEventDetail): Record<string, unknown> {
    if (target.kind === "widget") return { ...target, widget: detail.payload };
    const model = this.models.get(target.modelId);
    const object = target.layerId ? (detail.object ?? this.layerObjects.get(target.modelId)?.get(target.layerId) ?? model?.object) : model?.object;
    return {
      ...target,
      model,
      object,
      hitObject: detail.object,
      layer: target.layerId ? this.fragmentLayers.get(target.modelId)?.get(target.layerId) : undefined,
      fragmentModel: this.fragmentModels.get(target.modelId),
      properties: target.layerId ? this.componentRecord(target.modelId, target.layerId)?.properties : undefined,
    };
  }
  listAnnotations(): SceneAnnotationState[] {
    return [...this.annotations.values()].map(({ state }) => structuredClone(state));
  }
  getSelectedAnnotationId(): string | undefined {
    return this.selectedAnnotationId;
  }
  setAnnotationPlacementEnabled(enabled: boolean): void {
    this.annotationPlacementEnabled = enabled;
    if (enabled) this.setMeasureEnabled(false);
    this.updateToolCursor();
  }
  isAnnotationPlacementEnabled(): boolean {
    return this.annotationPlacementEnabled;
  }
  addAnnotation(annotation: SceneAnnotationState): void {
    this.removeAnnotation(annotation.id, false);
    const state = normalizeAnnotation(annotation);
    const object = createAnnotationVisual(state, this.selectedAnnotationId === state.id, this.readOnlyMode);
    const localAnchor = annotationLocalAnchor(state, this.annotationTarget(state));
    this.annotations.set(state.id, { state, object, ...(localAnchor ? { localAnchor } : {}) });
    this.scene.add(object);
  }
  updateAnnotation(id: string, patch: Partial<Omit<SceneAnnotationState, "id">>): SceneAnnotationState | undefined {
    const current = this.annotations.get(id);
    if (!current) return undefined;
    const next = normalizeAnnotation({ ...current.state, ...patch, id });
    this.disposeObject(current.object);
    const object = createAnnotationVisual(next, this.selectedAnnotationId === next.id, this.readOnlyMode);
    const targetChanged = "modelId" in patch || "layerId" in patch;
    const positionChanged = "position" in patch;
    const localAnchor = targetChanged || positionChanged
      ? annotationLocalAnchor(next, this.annotationTarget(next))
      : current.localAnchor;
    this.annotations.set(id, { state: next, object, ...(localAnchor ? { localAnchor } : {}) });
    this.scene.add(object);
    return structuredClone(next);
  }

  /** 在渲染帧中同步绑定标签，并把最新世界坐标写回快照状态。 */
  protected syncAnnotationAnchors(): void {
    for (const annotation of this.annotations.values()) {
      const worldAnchor = annotationWorldAnchor(
        this.annotationTarget(annotation.state),
        annotation.localAnchor,
      );
      if (!worldAnchor) continue;
      annotation.object.position.copy(worldAnchor);
      annotation.state.position = {
        x: worldAnchor.x,
        y: worldAnchor.y,
        z: worldAnchor.z,
      };
    }
  }

  private annotationTarget(annotation: SceneAnnotationState): THREE.Object3D | undefined {
    if (!annotation.modelId) return undefined;
    return (annotation.layerId
      ? this.layerObjects.get(annotation.modelId)?.get(annotation.layerId)
      : undefined) ?? this.models.get(annotation.modelId)?.object;
  }
  removeAnnotation(id: string, notify = true): void {
    const current = this.annotations.get(id);
    if (!current) return;
    this.disposeObject(current.object);
    this.annotations.delete(id);
    if (this.selectedAnnotationId === id) {
      this.selectedAnnotationId = undefined;
      if (notify) this.onAnnotationSelectionChange?.(undefined);
    }
  }
  clearAnnotations(notify = true): void {
    for (const id of [...this.annotations.keys()]) this.removeAnnotation(id, false);
    this.selectedAnnotationId = undefined;
    if (notify) this.onAnnotationSelectionChange?.(undefined);
  }
  selectAnnotation(id: string | undefined): void {
    if (id && !this.annotations.has(id)) return;
    if (this.selectedId) this.select(undefined);
    const previous = this.selectedAnnotationId;
    this.selectedAnnotationId = id;
    if (previous && previous !== id) this.refreshAnnotationVisual(previous);
    if (id) this.refreshAnnotationVisual(id);
    this.onAnnotationSelectionChange?.(id);
  }
  focusAnnotation(id: string): void {
    const annotation = this.annotations.get(id)?.state;
    if (!annotation) return;
    this.prepareForFocusedView();
    const target = new THREE.Vector3(annotation.position.x, annotation.position.y, annotation.position.z);
    const distance = Math.max(3.5, (annotation.size ?? 1) * 4);
    this.orbit.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
    this.orbit.update();
    this.rememberNavigationState("orbit");
    this.selectAnnotation(id);
  }
  getSceneStatistics(): SceneStatistics {
    let triangleCount = 0;
    let vertexCount = 0;
    for (const model of this.models.values()) {
      model.object.traverse((object) => {
        const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; isMesh?: boolean };
        if (!renderable.geometry?.attributes.position || object.userData.layerDeleted) return;
        const positions = renderable.geometry.attributes.position.count;
        vertexCount += positions;
        if (renderable.isMesh) triangleCount += renderable.geometry.index ? renderable.geometry.index.count / 3 : positions / 3;
      });
    }
    return {
      modelCount: [...this.models.values()].filter((item) => item.kind === "model").length,
      primitiveCount: [...this.models.values()].filter((item) => item.kind === "primitive").length,
      componentCount: this.getComponentCount(),
      triangleCount: Math.round(triangleCount),
      vertexCount,
    };
  }
  getFrameRate(): number {
    return this.getPerformanceSnapshot().fps;
  }
  getPerformanceSnapshot(): FramePerformanceSnapshot {
    const snapshot = this.framePerformanceMonitor.snapshot(this.readRendererLoad(), readHeapSnapshot(), this.longTaskMonitor.snapshot());
    const gpuFrameTime = this.gpuFrameTimeMonitor.snapshot();
    return gpuFrameTime.supported ? { ...snapshot, gpuFrameTime } : snapshot;
  }
  setGpuTimingEnabled(enabled: boolean): void {
    this.gpuFrameTimeMonitor.setEnabled(enabled);
  }
  applySceneDataMessage(message: DataMessage): boolean {
    const target = message.target;
    if (!target || !message.action) return false;
    this.markShadowMapDirty();
    if (message.action === "alarm" && target.modelId) {
      const model=this.models.get(target.modelId);
      if(!model)return false;
      const object=target.layerId?this.layerObjects.get(target.modelId)?.get(target.layerId):model.object;
      if(!object)return false;
      return applyViewerDeviceSignal(this,{modelId:target.modelId,target:object,
        scene:this.scene,container:this.container,value:message.value,getEffects:()=>this.getModelEffects(target.modelId!),setEffects:effects=>this.setModelEffects(target.modelId!,effects)});
    }
    if (message.action === "visibility" && target.modelId) {
      const visible = Boolean(message.value);
      if (target.layerId) this.setLayerVisible(target.modelId, target.layerId, visible);
      else this.setVisible(target.modelId, visible);
      return true;
    }
    if (message.action === "color" && target.modelId && typeof message.value === "string" && /^#[0-9a-f]{6}$/i.test(message.value)) {
      if (target.layerId) {
        const entry = this.fragmentLayers.get(target.modelId)?.get(target.layerId);
        const fragmentModel = this.fragmentModels.get(target.modelId);
        if (entry && fragmentModel) void fragmentModel.setColor(entry.localIds, new THREE.Color(message.value));
        else {
          const object = this.layerObjects.get(target.modelId)?.get(target.layerId);
          if (object) this.setObjectColor(object, message.value);
        }
      } else {
        const model = this.models.get(target.modelId);
        if (model) this.setObjectColor(model.object, message.value);
      }
      return true;
    }
    if (message.action === "position" && target.modelId && isVectorValue(message.value)) {
      const model = this.models.get(target.modelId);
      if (!model) return false;
      model.object.position.set(message.value.x, message.value.y, message.value.z);
      model.object.updateWorldMatrix(true, true);
      return true;
    }
    if (message.action === "opacity" && target.modelId && typeof message.value === "number") {
      const model = this.models.get(target.modelId);
      if (!model) return false;
      this.setObjectOpacity(model.object, THREE.MathUtils.clamp(message.value, 0, 1));
      model.opacity = THREE.MathUtils.clamp(message.value, 0, 1);
      return true;
    }
    if (message.action === "focus" && target.modelId) {
      const model = this.models.get(target.modelId);
      if (!model) return false;
      this.focusObject(target.layerId ? (this.layerObjects.get(target.modelId)?.get(target.layerId) ?? model.object) : model.object);
      return true;
    }
    if (message.action === "animation" && target.modelId) {
      this.setAnimationEnabled(target.modelId, Boolean(message.value));
      return true;
    }
    if (message.action === "material" && target.modelId && !target.layerId) {
      try {
        this.setModelMaterial(target.modelId, normalizeMaterialDataPatch(message.value));
        return true;
      } catch {
        return false;
      }
    }
    if (message.action === "effects" && target.modelId && message.value && typeof message.value === "object") {
      this.setModelEffects(
        target.modelId,
        mergeModelEffectsPatch(this.getModelEffects(target.modelId), message.value as ModelEffectsPatch),
      );
      return true;
    }
    if (message.action === "label" && target.annotationId) {
      const value = typeof message.value === "string" ? message.value : JSON.stringify(message.value);
      return Boolean(this.updateAnnotation(target.annotationId, { description: value }));
    }
    return false;
  }
  hasAnimation(id: string): boolean {
    return this.mixers.has(id);
  }
  listAnimationClips(id: string): Array<{ id: string; name: string; duration: number }> {
    return (this.animationClips.get(id) ?? []).map((clip) => ({ id: clip.name || clip.uuid, name: clip.name || clip.uuid, duration: clip.duration }));
  }
  getAnimationPlayback(id: string): { clipId?: string; time: number; duration: number; playing: boolean; autoplay: boolean; loopMode: "once" | "loop" } | undefined {
    const mixer = this.mixers.get(id);
    const clips = this.animationClips.get(id) ?? [];
    if (!mixer || clips.length === 0) return undefined;
    const selectedId = this.animationClipSelection.get(id);
    const selected = selectedId ? clips.find((clip) => (clip.name || clip.uuid) === selectedId) : clips[0];
    const duration = Math.max(0, selected?.duration ?? Math.max(...clips.map((clip) => clip.duration)));
    const policy = this.getModelAnimationPlaybackState(id);
    const time = duration > 0 ? (policy.loopMode === "loop" ? mixer.time % duration : Math.min(mixer.time, duration)) : mixer.time;
    return {
      ...(selected ? { clipId: selected.name || selected.uuid } : {}),
      time,
      duration,
      playing: this.animationEnabledIds.has(id) && mixer.timeScale !== 0,
      ...policy,
    };
  }
  getModelAnimationPlaybackState(id: string): SceneModelAnimationPlaybackState {
    return structuredClone(this.modelAnimationPlaybackStates.get(id) ?? { autoplay: true, loopMode: "loop" });
  }
  setModelAnimationPlaybackState(id: string, state: SceneModelAnimationPlaybackState): void {
    const next: SceneModelAnimationPlaybackState = { autoplay: Boolean(state.autoplay), loopMode: state.loopMode === "once" ? "once" : "loop" };
    this.modelAnimationPlaybackStates.set(id, next);
    this.applyModelAnimationLoopPolicy(id);
    const model = this.models.get(id);
    if (model) this.onModelChange?.(model);
  }
  protected applyModelAnimationLoopPolicy(id: string, clips = this.animationClips.get(id) ?? []): void {
    const mixer = this.mixers.get(id);
    if (!mixer) return;
    const policy = this.getModelAnimationPlaybackState(id);
    for (const clip of clips) {
      const action = mixer.clipAction(clip);
      action.clampWhenFinished = policy.loopMode === "once";
      action.setLoop(policy.loopMode === "once" ? THREE.LoopOnce : THREE.LoopRepeat, policy.loopMode === "once" ? 1 : Infinity);
    }
  }
  protected restartModelAnimationActions(id: string): void {
    const mixer = this.mixers.get(id);
    const clips = this.animationClips.get(id) ?? [];
    if (!mixer) return;
    const activeId = this.animationClipSelection.get(id);
    const active = activeId ? clips.filter((clip) => (clip.name || clip.uuid) === activeId) : clips;
    this.applyModelAnimationLoopPolicy(id, active);
    active.forEach((clip) => mixer.clipAction(clip).reset().play());
  }
  protected updateCompletedModelAnimations(): void {
    for (const id of [...this.animationEnabledIds]) {
      if (this.getModelAnimationPlaybackState(id).loopMode !== "once") continue;
      const mixer = this.mixers.get(id);
      const clips = this.animationClips.get(id) ?? [];
      const selectedId = this.animationClipSelection.get(id);
      const active = selectedId ? clips.filter((clip) => (clip.name || clip.uuid) === selectedId) : clips;
      if (!mixer || active.length === 0 || active.some((clip) => mixer.existingAction(clip)?.isRunning())) continue;
      this.animationEnabledIds.delete(id);
      const model = this.models.get(id);
      if (model) this.onModelChange?.(model);
      queueMicrotask(() => this.dispatchObjectLifecycle("animationEnd", id));
    }
  }
  controlAnimation(id: string, control: { action: "play" | "pause" | "stop" | "seek"; clipId?: string; time?: number }): boolean {
    const mixer = this.mixers.get(id);
    const clips = this.animationClips.get(id) ?? [];
    if (!mixer || clips.length === 0) return false;
    const selected = control.clipId ? clips.find((clip) => clip.name === control.clipId || clip.uuid === control.clipId) : undefined;
    if (control.clipId && !selected) return false;
    if (selected) this.animationClipSelection.set(id, selected.name || selected.uuid);
    const activeId = this.animationClipSelection.get(id);
    const active = activeId ? clips.find((clip) => (clip.name || clip.uuid) === activeId) : undefined;
    if (control.action === "play") {
      mixer.stopAllAction();
      this.applyModelAnimationLoopPolicy(id, active ? [active] : clips);
      (active ? [active] : clips).forEach((clip) => mixer.clipAction(clip).reset().play());
      mixer.timeScale = 1;
      this.animationEnabledIds.add(id);
    } else if (control.action === "pause") {
      mixer.timeScale = 0;
      this.animationEnabledIds.delete(id);
    } else if (control.action === "stop") {
      mixer.stopAllAction();
      mixer.setTime(0);
      mixer.timeScale = 0;
      this.animationEnabledIds.delete(id);
    } else {
      if (control.time === undefined || !Number.isFinite(control.time) || control.time < 0) return false;
      mixer.setTime(control.time);
    }
    const model = this.models.get(id);
    if (model) this.onModelChange?.(model);
    return true;
  }
}
