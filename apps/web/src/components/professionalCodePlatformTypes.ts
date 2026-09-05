import { STUDIO_API_DECLARATIONS } from "../studio/studioApi";

export const PLATFORM_TYPES = `
type Vec3 = [number, number, number];
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface StudioProjectIdentifiers {}
type ProjectIdentifier<K extends string> = K extends keyof StudioProjectIdentifiers ? StudioProjectIdentifiers[K] : string;
type ProjectObjectId = ProjectIdentifier<"object">;
type ProjectComponentId = ProjectIdentifier<"component">;
type ProjectUnityComponentId = ProjectIdentifier<"unityComponent">;
type ProjectDataKey = ProjectIdentifier<"dataKey">;
type ProjectSceneId = ProjectIdentifier<"scene">;
type ProjectPageId = ProjectIdentifier<"page">;
type ProjectCameraViewId = ProjectIdentifier<"cameraView">;
interface SceneObjectHandle {
  readonly id: string;
  show(): void;
  hide(): void;
  select(): void;
  focus(): void;
  setPosition(x: number, y: number, z: number): void;
  setRotation(x: number, y: number, z: number): void;
  setScale(x: number, y?: number, z?: number): void;
  playAnimation(name?: string): void;
  pauseAnimation(name?: string): void;
  stopAnimation(name?: string): void;
  seekAnimation(seconds: number, name?: string): void;
  setColor(color: string): void;
  setOpacity(opacity: number): void;
}
interface SceneComponentHandle {
  readonly id: string;
  update(patch: Record<string, JsonValue>): void;
  show(): void;
  hide(): void;
  rename(name: string): void;
}
interface SceneUnityHandle {
  readonly id: string;
  setProperty(key: string, value: JsonValue): void;
  setProperties(values: Record<string, JsonValue>): void;
  invoke(action: string, objectId?: string, value?: JsonValue): void;
  switchScene(scene: string): void;
}
interface StudioComponentHandle {
  readonly id: string;
  readonly name?: string;
  readonly pageId: string;
  readonly kind: "data-widget" | "scene-viewport";
  update(patch: Record<string, unknown>): void;
  show(): void;
  hide(): void;
}
${STUDIO_API_DECLARATIONS}
interface StudioAIAPI {
  /** 通过宿主受控网关调用已上线的工业 AI 能力；结果保留状态、证据和建议动作。 */
  invoke(capabilityId: string, input?: JsonValue): Promise<JsonValue>;
}
interface StudioAPI { readonly ai: StudioAIAPI; }
interface SceneCommand { id?: string; type: string; [key: string]: JsonValue | undefined; }
interface StudioProjectEventNames {}
type ProjectEventName = keyof StudioProjectEventNames extends never ? string : keyof StudioProjectEventNames;
interface BehaviorSceneEvent {
  readonly type: "scene.ready" | "scene.disposed" | "selection.changed" | "object.event" | "business.event" | "data.received" | string;
  readonly name?: ProjectEventName;
  readonly sceneId?: string;
  readonly sourceModuleId?: string;
  readonly target?: unknown;
  readonly data?: JsonValue;
  readonly timestamp?: string;
}
interface BehaviorContext {
  readonly sceneId: string;
  readonly target: { readonly kind: "scene" } | { readonly kind: "object" | "component"; readonly id: string };
  readonly self?: SceneObjectHandle | SceneComponentHandle;
  readonly deltaMs: number;
  readonly elapsedMs: number;
  readonly deltaTime: number;
  readonly elapsedTime: number;
  readonly state: Record<string, unknown>;
  readonly data?: JsonValue;
  readonly event?: BehaviorSceneEvent;
  object(id: ProjectObjectId): SceneObjectHandle | undefined;
  objects(query?: string): readonly SceneObjectHandle[];
  command(command: SceneCommand): void;
  getData(key: ProjectDataKey): JsonValue | undefined;
  setData(key: ProjectDataKey, value: JsonValue): void;
  emit(name: ProjectEventName, payload?: JsonValue): void;
  readonly THREE: typeof import("three");
  readonly studio: StudioAPI;
  readonly net: StudioNetworkAPI;
  log(message: string, detail?: unknown): void;
}
interface StudioNetworkResult<T = JsonValue> { readonly ok: true; readonly status: number; readonly data: T; readonly value: JsonValue; }
interface StudioNetworkFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | null>;
  body?: JsonValue;
  credentialRef?: string;
  variables?: Record<string, JsonValue>;
  select?: { jsonPath?: string; field?: string };
}
interface StudioNetworkAPI {
  fetch<T = JsonValue>(endpoint: string, options?: StudioNetworkFetchOptions): Promise<StudioNetworkResult<T>>;
  request<T = JsonValue>(binding: Record<string, unknown>, variables?: Record<string, JsonValue>): Promise<StudioNetworkResult<T>>;
}
interface InteractionContext {
  readonly engine: unknown;
  readonly THREE: typeof import("three");
  readonly target: { kind: "object" | "widget"; modelId?: string; layerId?: string; widgetId?: string };
  readonly event: { type: string; payload?: JsonValue };
  action(type: string, options?: Record<string, JsonValue>): Promise<void>;
  getData(key: string): JsonValue | undefined;
  setData(key: string, value: JsonValue): void;
  log(message: string, detail?: unknown): void;
}
declare const ctx: BehaviorContext & InteractionContext;
declare const studio: StudioAPI;
declare const app: unknown;
declare const engine: unknown;
declare const THREE: typeof import("three");
declare const net: StudioNetworkAPI;
declare function fetch<T = JsonValue>(endpoint: string, options?: StudioNetworkFetchOptions): Promise<StudioNetworkResult<T>>;
declare function onStart(ctx: BehaviorContext): void | Promise<void>;
declare function onUpdate(ctx: BehaviorContext): void | Promise<void>;
declare function onFixedUpdate(ctx: BehaviorContext): void | Promise<void>;
declare function onData(ctx: BehaviorContext): void | Promise<void>;
declare function onEvent(ctx: BehaviorContext): void | Promise<void>;
declare function onStop(ctx: BehaviorContext): void | Promise<void>;
declare function onDispose(ctx: BehaviorContext): void | Promise<void>;
`;
