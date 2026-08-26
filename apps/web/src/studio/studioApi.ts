import type {
  CameraState,
  ModelTransform,
  SceneEnvironmentState,
  ScenePhysicsState,
  ScenePostProcessingState,
  Vector3Value,
  WeatherMode
} from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";

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
  setCollision(enabled: boolean): void;
  explode(factor: number, mode?: "radial" | "vertical" | "x" | "y" | "z"): void;
  playAnimation(): void;
  stopAnimation(): void;
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

export function createStudioViewerAPI(engine: ViewerEngine | undefined, options: StudioViewerApiOptions = {}): StudioViewerAPI {
  const emit = (action: Record<string, unknown>) => options.emitAction?.(action);
  const find = (idOrName: string) => {
    const key = idOrName.trim().toLocaleLowerCase();
    return engine?.listModels().find((model) => model.id.toLocaleLowerCase() === key || model.name.toLocaleLowerCase() === key);
  };
  const handle = (model: NonNullable<ReturnType<typeof find>>): StudioObjectHandle => {
    const transform = engine?.getModelTransform(model.id) ?? identityTransform();
    const objectAction = (type: string, value?: unknown) => emit({ type, ...(options.sceneId ? { sceneId: options.sceneId } : {}), target: { kind: "object", modelId: model.id }, ...(value === undefined ? {} : { value }) });
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
      focus: () => engine ? engine.focusModel(model.id) : objectAction("focus"),
      show: () => engine ? engine.setVisible(model.id, true) : objectAction("visibility", "show"),
      hide: () => engine ? engine.setVisible(model.id, false) : objectAction("visibility", "hide"),
      toggle: () => engine ? engine.setVisible(model.id, !model.visible) : objectAction("visibility", "toggle"),
      rename: (name: string) => engine?.rename(model.id, name),
      setPosition: (x: number, y: number, z: number) => engine?.setModelTransform(model.id, { position: [x, y, z] }),
      setRotation: (x: number, y: number, z: number) => engine?.setModelTransform(model.id, { rotation: [x, y, z] }),
      setScale: (x: number, y = x, z = x) => engine?.setModelTransform(model.id, { scale: [x, y, z] }),
      setTransform: (patch: Partial<{ position: StudioVector3; rotation: StudioVector3; scale: StudioVector3 }>) => engine?.setModelTransform(model.id, {
        ...(patch.position ? { position: [...patch.position] } : {}),
        ...(patch.rotation ? { rotation: [...patch.rotation] } : {}),
        ...(patch.scale ? { scale: [...patch.scale] } : {})
      }),
      setColor: (color: string) => engine ? applyObjectColor(engine, model.id, color) : objectAction("color", color),
      setOpacity: (opacity: number) => engine ? engine.setOpacity(model.id, clamp(opacity, 0, 1)) : objectAction("opacity", clamp(opacity, 0, 1)),
      setCollision: (enabled: boolean) => engine?.setCollisionEnabled(model.id, enabled),
      explode: (factor: number, mode: "radial" | "vertical" | "x" | "y" | "z" = "radial") => engine?.setExplosion(model.id, Math.max(0, factor), mode),
      playAnimation: () => engine ? engine.setAnimationEnabled(model.id, true) : objectAction("animation", "play"),
      stopAnimation: () => engine ? engine.setAnimationEnabled(model.id, false) : objectAction("animation", "stop"),
      remove: () => engine?.removeModel(model.id)
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
      applyView: (cameraViewId: string, sceneId?: string) => emit({ type: "cameraView", cameraViewId, ...(sceneId || options.sceneId ? { sceneId: sceneId ?? options.sceneId } : {}) })
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
      setPhysics: (state: ScenePhysicsState) => engine?.setPhysicsState(state)
    }),
    animation: Object.freeze({
      play: () => engine?.playSceneAnimation(),
      pause: () => engine?.pauseSceneAnimation(),
      seek: (seconds: number) => engine?.seekSceneAnimation(seconds),
      isPlaying: () => engine?.isSceneAnimationPlaying() ?? false
    }),
    selection: Object.freeze({
      get: () => {
        const selected = engine?.getSelected();
        return selected ? handle(selected) : undefined;
      },
      clear: () => engine?.select(undefined)
    })
  });
}

export const STUDIO_API_DECLARATIONS = `
type StudioVector3 = readonly [number, number, number];
type StudioNavigationMode = "orbit" | "firstPerson" | "thirdPerson";
interface StudioObjectHandle {
  readonly id: string; readonly name: string; readonly sceneId?: string; readonly kind: "model" | "primitive";
  readonly visible: boolean; readonly opacity: number; readonly position: StudioVector3; readonly rotation: StudioVector3; readonly scale: StudioVector3; readonly raw?: import("three").Object3D;
  select(): void; focus(): void; show(): void; hide(): void; toggle(): void; rename(name: string): void;
  setPosition(x: number, y: number, z: number): void; setRotation(x: number, y: number, z: number): void; setScale(x: number, y?: number, z?: number): void;
  setTransform(transform: Partial<{ position: StudioVector3; rotation: StudioVector3; scale: StudioVector3 }>): void;
  setColor(color: string): void; setOpacity(opacity: number): void; setCollision(enabled: boolean): void;
  explode(factor: number, mode?: "radial" | "vertical" | "x" | "y" | "z"): void; playAnimation(): void; stopAnimation(): void; remove(): void;
}
interface StudioAPI {
  readonly version: "1.0"; readonly application?: unknown; readonly pages?: readonly unknown[]; readonly scenes?: readonly unknown[]; readonly topologies?: readonly unknown[];
  readonly source?: unknown; readonly trigger?: string; readonly raw: { engine?: unknown; scene?: import("three").Scene; camera?: import("three").Camera; renderer?: unknown };
  object(idOrName: string): StudioObjectHandle | undefined; objects(query?: string): readonly StudioObjectHandle[]; query(selector: string): readonly StudioObjectHandle[];
  component(idOrName: string): StudioComponentHandle | undefined; components(): readonly StudioComponentHandle[]; updateComponent(idOrName: string, patch: Record<string, unknown>): void;
  page: { open(pageId: string): void };
  camera: { getState(): unknown; setPose(position: StudioVector3, target: StudioVector3, options?: { near?: number; far?: number; fov?: number }): void; setMode(mode: StudioNavigationMode): void; setClip(near: number, far: number): void; setCollision(enabled: boolean, radius?: number): void; setStandardView(view: "top" | "bottom" | "left" | "right" | "front" | "back"): void; applyView(cameraViewId: string, sceneId?: string): void };
  scene: { open(sceneId: string, newTab?: boolean): void; statistics(): unknown; rendererBackend(): "webgl" | "webgpu" | undefined; getWeather(): "sunny" | "rain" | "snow" | undefined; setWeather(mode: "sunny" | "rain" | "snow"): void; getEnvironment(): unknown; setEnvironment(state: Record<string, unknown>): void; getPostProcessing(): unknown; setPostProcessing(state: Record<string, unknown>): void; getPhysics(): unknown; setPhysics(state: Record<string, unknown>): void };
  animation: { play(): void; pause(): void; seek(seconds: number): void; isPlaying(): boolean };
  selection: { get(): StudioObjectHandle | undefined; clear(): void };
  action(action: Record<string, unknown> & { type: string }): void; getData(key: string): JsonValue | undefined; setData(key: string, value: JsonValue): void; log(message: string, detail?: unknown): void;
}
`;

function vectorTuple(value: Vector3Value): StudioVector3 {
  return [value.x, value.y, value.z];
}

function identityTransform(): ModelTransform {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
}

function applyObjectColor(engine: ViewerEngine, id: string, color: string): void {
  engine.setColor(id, color);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
