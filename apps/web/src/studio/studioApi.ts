import type {
  CameraState,
  ModelTransform,
  SceneEnvironmentState,
  SceneFireEffectState,
  SceneMaterialScreenState,
  SceneMaterialState,
  ScenePhysicsState,
  ScenePostProcessingState,
  SceneSpatialAudioState,
  Vector3Value,
  WeatherMode,
} from "@bim-studio/contracts";
import type { ViewerEngineContract } from "../viewer/viewerEngineContract";
import { mergeModelEffectsPatch } from "../viewer/modelEffectState";

export type StudioVector3 = readonly [number, number, number];
export type StudioNavigationMode = CameraState["mode"];
export type StudioStandardView = "top" | "bottom" | "left" | "right" | "front" | "back";

export interface StudioObjectHandle {
  readonly id: string;
  readonly name: string;
  readonly sceneId?: string;
  readonly kind: "model" | "primitive";
  readonly visible: boolean;
  readonly opacity: number;
  readonly position: StudioVector3;
  readonly rotation: StudioVector3;
  readonly scale: StudioVector3;
  readonly raw?: unknown;
  select(): void;
  focus(): void;
  show(): void;
  hide(): void;
  toggle(): void;
  rename(name: string): void;
  setPosition(x: number, y: number, z: number): void;
  setRotation(x: number, y: number, z: number): void;
  setScale(x: number, y?: number, z?: number): void;
  setTransform(transform: Partial<{ position: StudioVector3; rotation: StudioVector3; scale: StudioVector3 }>): void;
  setColor(color: string): void;
  setOpacity(opacity: number): void;
  getMaterial(): SceneMaterialState | undefined;
  setMaterial(patch: SceneMaterialState): void;
  setCollision(enabled: boolean): void;
  setFire(enabled: boolean, options?: Partial<Omit<SceneFireEffectState, "enabled">>): void;
  explode(factor: number, mode?: "radial" | "vertical" | "x" | "y" | "z"): void;
  playAnimation(clipName?: string): void;
  pauseAnimation(clipName?: string): void;
  stopAnimation(clipName?: string): void;
  seekAnimation(seconds: number, clipName?: string): void;
  setScreenMedia(url: string, options?: Partial<Omit<SceneMaterialScreenState, "url" | "enabled">>): void;
  playScreen(): void;
  pauseScreen(): void;
  hideScreen(): void;
  setSpatialAudio(url: string, options?: Partial<Omit<SceneSpatialAudioState, "url" | "enabled">>): void;
  playSpatialAudio(): void;
  pauseSpatialAudio(): void;
  stopSpatialAudio(): void;
  replaySpatialAudio(): void;
  dispatchRoute(): void;
  pauseRoute(): void;
  resumeRoute(): void;
  stopRoute(): void;
  replayRoute(): void;
  returnRoute(): void;
  remove(): void;
}

export interface StudioViewerAPI {
  readonly version: "1.0";
  readonly raw: Readonly<{ engine?: unknown; scene?: unknown; camera?: unknown; renderer?: unknown }>;
  object(idOrName: string): StudioObjectHandle | undefined;
  objects(query?: string): readonly StudioObjectHandle[];
  query(selector: string): readonly StudioObjectHandle[];
  camera: {
    getState(): CameraState | undefined;
    setPose(position: StudioVector3, target: StudioVector3, options?: { near?: number; far?: number; fov?: number }): void;
    setMode(mode: StudioNavigationMode): void;
    setClip(near: number, far: number): void;
    setCollision(enabled: boolean, radius?: number): void;
    setStandardView(view: StudioStandardView): void;
    applyView(cameraViewId: string, sceneId?: string): void;
  };
  scene: {
    open(sceneId: string, newTab?: boolean): void;
    statistics(): unknown;
    rendererBackend(): "webgl" | "webgpu" | undefined;
    getWeather(): WeatherMode | undefined;
    setWeather(mode: WeatherMode): void;
    getEnvironment(): SceneEnvironmentState | undefined;
    setEnvironment(state: SceneEnvironmentState): void;
    getPostProcessing(): ScenePostProcessingState | undefined;
    setPostProcessing(state: ScenePostProcessingState): void;
    getPhysics(): ScenePhysicsState | undefined;
    setPhysics(state: ScenePhysicsState): void;
  };
  animation: {
    play(): void;
    pause(): void;
    seek(seconds: number): void;
    isPlaying(): boolean;
  };
  selection: {
    get(): StudioObjectHandle | undefined;
    clear(): void;
  };
}

export interface StudioViewerApiOptions {
  sceneId?: string;
  emitAction?: (action: Record<string, unknown>) => void;
}

export function createStudioViewerAPI(engine: ViewerEngineContract | undefined, options: StudioViewerApiOptions = {}): StudioViewerAPI {
  const emit = (action: Record<string, unknown>) => options.emitAction?.(action);
  const find = (idOrName: string) => {
    const key = idOrName.trim().toLocaleLowerCase();
    return engine?.listModels().find((model) => model.id.toLocaleLowerCase() === key || model.name.toLocaleLowerCase() === key);
  };
  const handle = (model: NonNullable<ReturnType<typeof find>>): StudioObjectHandle => {
    const transform = engine?.getModelTransform(model.id) ?? identityTransform();
    const objectAction = (type: string, value?: unknown, prefabAction?: string) =>
      emit({
        type,
        ...(options.sceneId ? { sceneId: options.sceneId } : {}),
        target: { kind: "object", modelId: model.id },
        ...(value === undefined ? {} : { value }),
        ...(prefabAction ? { prefabAction } : {}),
      });
    return Object.freeze({
      id: model.id,
      name: model.name,
      ...(options.sceneId ? { sceneId: options.sceneId } : {}),
      kind: model.kind,
      visible: model.visible,
      opacity: model.opacity,
      position: vectorTuple(transform.position),
      rotation: vectorTuple(transform.rotation),
      scale: vectorTuple(transform.scale),
      raw: engine?.getRawObject(model.id),
      select: () => engine?.select(model.id),
      focus: () => (engine ? engine.focusModel(model.id) : objectAction("focus")),
      show: () => (engine ? engine.setVisible(model.id, true) : objectAction("visibility", "show")),
      hide: () => (engine ? engine.setVisible(model.id, false) : objectAction("visibility", "hide")),
      toggle: () => (engine ? engine.setVisible(model.id, !model.visible) : objectAction("visibility", "toggle")),
      rename: (name: string) => engine?.rename(model.id, name),
      setPosition: (x: number, y: number, z: number) => engine?.setModelTransform(model.id, { position: [x, y, z] }),
      setRotation: (x: number, y: number, z: number) => engine?.setModelTransform(model.id, { rotation: [x, y, z] }),
      setScale: (x: number, y = x, z = x) => engine?.setModelTransform(model.id, { scale: [x, y, z] }),
      setTransform: (patch: Partial<{ position: StudioVector3; rotation: StudioVector3; scale: StudioVector3 }>) =>
        engine?.setModelTransform(model.id, {
          ...(patch.position ? { position: [...patch.position] } : {}),
          ...(patch.rotation ? { rotation: [...patch.rotation] } : {}),
          ...(patch.scale ? { scale: [...patch.scale] } : {}),
        }),
      setColor: (color: string) => (engine ? applyObjectColor(engine, model.id, color) : objectAction("color", color)),
      setOpacity: (opacity: number) => (engine ? engine.setOpacity(model.id, clamp(opacity, 0, 1)) : objectAction("opacity", clamp(opacity, 0, 1))),
      getMaterial: () => engine?.getModelMaterialState(model.id),
      setMaterial: (patch: SceneMaterialState) => engine?.setModelMaterial(model.id, structuredClone(patch)),
      setCollision: (enabled: boolean) => engine?.setCollisionEnabled(model.id, enabled),
      setFire: (enabled: boolean, fireOptions: Partial<Omit<SceneFireEffectState, "enabled">> = {}) => {
        if (!engine) return objectAction("effects", { fire: { enabled, ...fireOptions } });
        engine.setModelEffects(
          model.id,
          mergeModelEffectsPatch(engine.getModelEffects(model.id), { fire: { enabled, ...fireOptions } }),
        );
      },
      explode: (factor: number, mode: "radial" | "vertical" | "x" | "y" | "z" = "radial") => engine?.setExplosion(model.id, Math.max(0, factor), mode),
      playAnimation: (clipName?: string) =>
        engine
          ? engine.controlAnimation(model.id, { action: "play", ...(clipName ? { clipId: clipName } : {}) })
          : objectAction("animation", { action: "play", ...(clipName ? { clipId: clipName } : {}) }),
      pauseAnimation: (clipName?: string) =>
        engine
          ? engine.controlAnimation(model.id, { action: "pause", ...(clipName ? { clipId: clipName } : {}) })
          : objectAction("animation", { action: "pause", ...(clipName ? { clipId: clipName } : {}) }),
      stopAnimation: (clipName?: string) =>
        engine
          ? engine.controlAnimation(model.id, { action: "stop", ...(clipName ? { clipId: clipName } : {}) })
          : objectAction("animation", { action: "stop", ...(clipName ? { clipId: clipName } : {}) }),
      seekAnimation: (seconds: number, clipName?: string) =>
        engine
          ? engine.controlAnimation(model.id, { action: "seek", time: seconds, ...(clipName ? { clipId: clipName } : {}) })
          : objectAction("animation", { action: "seek", time: seconds, ...(clipName ? { clipId: clipName } : {}) }),
      setScreenMedia: (url: string, screenOptions: Partial<Omit<SceneMaterialScreenState, "url" | "enabled">> = {}) => {
        if (!engine) return;
        const current = engine.getModelMaterialOverride(model.id)?.screen;
        const name = screenOptions.name ?? current?.name;
        engine.setModelMaterial(model.id, {
          screen: {
            enabled: true,
            sourceType: screenOptions.sourceType ?? current?.sourceType ?? "video",
            url,
            ...(name ? { name } : {}),
            autoplay: screenOptions.autoplay ?? current?.autoplay ?? true,
            loopMode: screenOptions.loopMode ?? current?.loopMode ?? "loop",
            muted: screenOptions.muted ?? current?.muted ?? true,
            emissiveIntensity: screenOptions.emissiveIntensity ?? current?.emissiveIntensity ?? 1,
          },
        });
      },
      playScreen: () => updateScreenPlayback(engine, model.id, { enabled: true, autoplay: true }),
      pauseScreen: () => updateScreenPlayback(engine, model.id, { autoplay: false }),
      hideScreen: () => updateScreenPlayback(engine, model.id, { enabled: false, autoplay: false }),
      setSpatialAudio: (url: string, audioOptions: Partial<Omit<SceneSpatialAudioState, "url" | "enabled">> = {}) => {
        if (!engine) return;
        const current = engine.getSpatialAudioState(model.id);
        const name = audioOptions.name ?? current?.name;
        engine.setSpatialAudioState(model.id, {
          enabled: true,
          url,
          ...(name ? { name } : {}),
          autoplay: audioOptions.autoplay ?? current?.autoplay ?? true,
          loopMode: audioOptions.loopMode ?? current?.loopMode ?? "loop",
          muted: audioOptions.muted ?? current?.muted ?? false,
          volume: audioOptions.volume ?? current?.volume ?? 0.7,
          refDistance: audioOptions.refDistance ?? current?.refDistance ?? 2,
          maxDistance: audioOptions.maxDistance ?? current?.maxDistance ?? 50,
          rolloffFactor: audioOptions.rolloffFactor ?? current?.rolloffFactor ?? 1,
        });
      },
      playSpatialAudio: () => engine?.controlSpatialAudio(model.id, "play"),
      pauseSpatialAudio: () => engine?.controlSpatialAudio(model.id, "pause"),
      stopSpatialAudio: () => engine?.controlSpatialAudio(model.id, "stop"),
      replaySpatialAudio: () => engine?.controlSpatialAudio(model.id, "replay"),
      dispatchRoute: () => (engine ? engine.executeIndustrialPrefabAction(model.id, "dispatch") : objectAction("prefabAction", undefined, "dispatch")),
      pauseRoute: () => (engine ? engine.executeIndustrialPrefabAction(model.id, "pause") : objectAction("prefabAction", undefined, "pause")),
      resumeRoute: () => (engine ? engine.executeIndustrialPrefabAction(model.id, "resume") : objectAction("prefabAction", undefined, "resume")),
      stopRoute: () => (engine ? engine.executeIndustrialPrefabAction(model.id, "stop") : objectAction("prefabAction", undefined, "stop")),
      replayRoute: () => (engine ? engine.executeIndustrialPrefabAction(model.id, "replay") : objectAction("prefabAction", undefined, "replay")),
      returnRoute: () => (engine ? engine.executeIndustrialPrefabAction(model.id, "return") : objectAction("prefabAction", undefined, "return")),
      remove: () => engine?.removeModel(model.id),
    });
  };
  const object = (idOrName: string) => {
    const model = find(idOrName);
    return model ? handle(model) : undefined;
  };
  const objects = (query = "") => {
    const key = query.trim().toLocaleLowerCase();
    return (engine?.listModels() ?? []).filter((model) => !key || model.id.toLocaleLowerCase().includes(key) || model.name.toLocaleLowerCase().includes(key)).map(handle);
  };
  return Object.freeze({
    version: "1.0" as const,
    raw: Object.freeze({ engine, scene: engine?.getRawScene(), camera: engine?.getRawCamera(), renderer: engine?.getRawRenderer() }),
    object,
    objects,
    query: objects,
    camera: Object.freeze({
      getState: () => engine?.getCameraState(),
      setPose: (position: StudioVector3, target: StudioVector3, cameraOptions = {}) => engine?.setCameraPose({ position: [...position], target: [...target], ...cameraOptions }),
      setMode: (mode: StudioNavigationMode) => engine?.setNavigationMode(mode),
      setClip: (near: number, far: number) => {
        if (!engine) return;
        engine.setCameraConstraints({ ...engine.getCameraConstraints(), nearClip: near, farClip: far });
      },
      setCollision: (enabled: boolean, radius?: number) => {
        if (!engine) return;
        engine.setCameraConstraints({ ...engine.getCameraConstraints(), collisionEnabled: enabled, ...(radius === undefined ? {} : { collisionRadius: radius }) });
      },
      setStandardView: (view: StudioStandardView) => engine?.setStandardView(view),
      applyView: (cameraViewId: string, sceneId?: string) =>
        emit({ type: "cameraView", cameraViewId, ...(sceneId || options.sceneId ? { sceneId: sceneId ?? options.sceneId } : {}) }),
    }),
    scene: Object.freeze({
      open: (sceneId: string, newTab = false) => emit({ type: "navigateScene", sceneId, newTab }),
      statistics: () => engine?.getSceneStatistics(),
      rendererBackend: () => engine?.getRendererBackend(),
      getWeather: () => engine?.getWeather(),
      setWeather: (mode: WeatherMode) => engine?.setWeather(mode),
      getEnvironment: () => engine?.getSceneEnvironment(),
      setEnvironment: (state: SceneEnvironmentState) => engine?.setSceneEnvironment(state),
      getPostProcessing: () => engine?.getPostProcessing(),
      setPostProcessing: (state: ScenePostProcessingState) => engine?.setPostProcessing(state),
      getPhysics: () => engine?.getPhysicsState(),
      setPhysics: (state: ScenePhysicsState) => engine?.setPhysicsState(state),
    }),
    animation: Object.freeze({
      play: () => engine?.playSceneAnimation(),
      pause: () => engine?.pauseSceneAnimation(),
      seek: (seconds: number) => engine?.seekSceneAnimation(seconds),
      isPlaying: () => engine?.isSceneAnimationPlaying() ?? false,
    }),
    selection: Object.freeze({
      get: () => {
        const selected = engine?.getSelected();
        return selected ? handle(selected) : undefined;
      },
      clear: () => engine?.select(undefined),
    }),
  });
}

export const STUDIO_API_DECLARATIONS = `
type StudioVector3 = readonly [number, number, number];
type StudioNavigationMode = "orbit" | "firstPerson" | "thirdPerson";
interface StudioMaterialState {
  color?: string; emissive?: string; emissiveIntensity?: number;
  roughness?: number; metalness?: number; normalScale?: number;
  baseColorMapUrl?: string; normalMapUrl?: string; emissiveMapUrl?: string;
  ambientOcclusionMapUrl?: string; roughnessMapUrl?: string; metalnessMapUrl?: string;
  textureRepeat?: number; textureRepeatX?: number; textureRepeatY?: number;
  textureOffsetX?: number; textureOffsetY?: number; textureRotation?: number;
  wireframe?: boolean; doubleSided?: boolean;
}
interface StudioObjectHandle {
  readonly id: string; readonly name: string; readonly sceneId?: string; readonly kind: "model" | "primitive";
  readonly visible: boolean; readonly opacity: number; readonly position: StudioVector3; readonly rotation: StudioVector3; readonly scale: StudioVector3; readonly raw?: import("three").Object3D;
  /** 选中对象并触发 selection.changed。 */
  select(): void; focus(): void; show(): void; hide(): void; toggle(): void; rename(name: string): void;
  /** 使用项目坐标设置对象位置。 */
  setPosition(x: number, y: number, z: number): void; setRotation(x: number, y: number, z: number): void; setScale(x: number, y?: number, z?: number): void;
  setTransform(transform: Partial<{ position: StudioVector3; rotation: StudioVector3; scale: StudioVector3 }>): void;
  setColor(color: string): void; setOpacity(opacity: number): void;
  /** 读取模型当前首个标准材质，并增量修改 PBR、贴图与 UV 参数。 */
  getMaterial(): StudioMaterialState | undefined;
  setMaterial(patch: StudioMaterialState): void;
  setCollision(enabled: boolean): void;
  /** 启用、关闭或调整对象火焰图层；参数修改保留其余已配置值。 */
  setFire(enabled: boolean, options?: Partial<{ color: string; intensity: number; height: number; density: number }>): void;
  /** 播放模型自带动画；clipName 为空时使用当前或首个片段。 */
  explode(factor: number, mode?: "radial" | "vertical" | "x" | "y" | "z"): void; playAnimation(clipName?: string): void; pauseAnimation(clipName?: string): void; stopAnimation(clipName?: string): void; seekAnimation(seconds: number, clipName?: string): void;
  /** 把项目图片/视频映射到模型表面，并控制视频播放。 */
  setScreenMedia(url: string, options?: Partial<{ sourceType: "image" | "video"; name: string; autoplay: boolean; loopMode: "once" | "loop"; muted: boolean; emissiveIntensity: number }>): void; playScreen(): void; pauseScreen(): void; hideScreen(): void;
  /** 把项目音频挂载到对象位置，支持距离衰减、自动播放、一次和循环。 */
  setSpatialAudio(url: string, options?: Partial<{ name: string; autoplay: boolean; loopMode: "once" | "loop"; muted: boolean; volume: number; refDistance: number; maxDistance: number; rolloffFactor: number }>): void; playSpatialAudio(): void; pauseSpatialAudio(): void; stopSpatialAudio(): void; replaySpatialAudio(): void;
  /** 控制人、车、AGV 等工业预制体路线。 */
  dispatchRoute(): void; pauseRoute(): void; resumeRoute(): void; stopRoute(): void; replayRoute(): void; returnRoute(): void; remove(): void;
}
interface StudioAPI {
  readonly version: "1.0";
  readonly application?: unknown;
  readonly pages?: readonly unknown[];
  readonly scenes?: readonly unknown[];
  readonly topologies?: readonly unknown[];
  readonly source?: unknown;
  readonly trigger?: string;
  readonly raw: {
    engine?: unknown;
    scene?: import("three").Scene;
    camera?: import("three").Camera;
    renderer?: unknown;
  };
  /** 按当前项目中的稳定 ID 或完整名称获取 3D 对象。 */
  object(idOrName: ProjectObjectId): StudioObjectHandle | undefined; objects(query?: string): readonly StudioObjectHandle[]; query(selector: string): readonly StudioObjectHandle[];
  /** 按稳定节点 ID 获取二维组件。 */
  component(idOrName: ProjectComponentId): StudioComponentHandle | undefined; components(): readonly StudioComponentHandle[]; updateComponent(idOrName: ProjectComponentId, patch: Record<string, unknown>): void;
  /** 控制项目中嵌入的 Unity 运行时；键、动作和场景由构建清单校验。 */
  unity(idOrName: ProjectUnityComponentId): SceneUnityHandle;
  /** 打开项目内二维页面。 */
  page: { open(pageId: ProjectPageId): void };
  /** 相机姿态、导航、裁剪和已保存视角。坐标统一使用当前项目坐标。 */
  camera: {
    getState(): unknown;
    setPose(position: StudioVector3, target: StudioVector3, options?: { near?: number; far?: number; fov?: number }): void;
    setMode(mode: StudioNavigationMode): void;
    setClip(near: number, far: number): void;
    setCollision(enabled: boolean, radius?: number): void;
    setStandardView(view: "top" | "bottom" | "left" | "right" | "front" | "back"): void;
    applyView(cameraViewId: ProjectCameraViewId, sceneId?: ProjectSceneId): void;
  };
  /** 场景切换、渲染后端、天气、环境、后处理与物理状态。 */
  scene: {
    open(sceneId: ProjectSceneId, newTab?: boolean): void;
    statistics(): unknown;
    rendererBackend(): "webgl" | "webgpu" | undefined;
    getWeather(): WeatherMode | undefined;
    setWeather(mode: WeatherMode): void;
    getEnvironment(): unknown;
    setEnvironment(state: Record<string, unknown>): void;
    getPostProcessing(): unknown;
    setPostProcessing(state: Record<string, unknown>): void;
    getPhysics(): unknown;
    setPhysics(state: Record<string, unknown>): void;
  };
  /** 控制应用级时间线。 */
  animation: { play(): void; pause(): void; seek(seconds: number): void; isPlaying(): boolean };
  selection: { get(): StudioObjectHandle | undefined; clear(): void };
  net: StudioNetworkAPI;
  /** 读取或写入平台数据；key 会根据当前项目生成字面量类型和补全。 */
  action(action: Record<string, unknown> & { type: string }): void; getData(key: ProjectDataKey): JsonValue | undefined; setData(key: ProjectDataKey, value: JsonValue): void; log(message: string, detail?: unknown): void;
}
`;

function vectorTuple(value: Vector3Value): StudioVector3 {
  return [value.x, value.y, value.z];
}

function identityTransform(): ModelTransform {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

function applyObjectColor(engine: ViewerEngineContract, id: string, color: string): void {
  engine.setColor(id, color);
}

function updateScreenPlayback(
  engine: ViewerEngineContract | undefined,
  modelId: string,
  patch: Pick<SceneMaterialScreenState, "autoplay"> & Partial<Pick<SceneMaterialScreenState, "enabled">>,
): void {
  if (!engine) return;
  const current = engine.getModelMaterialOverride(modelId)?.screen;
  if (!current) return;
  engine.setModelMaterial(modelId, { screen: { ...current, ...patch } });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
