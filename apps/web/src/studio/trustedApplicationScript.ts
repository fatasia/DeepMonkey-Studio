import type {
  ApplicationDocument,
  ApplicationObjectRef,
  InteractionFlow,
  JsonValue,
  SceneInteractionActionState,
  SceneInteractionTrigger
} from "@bim-studio/contracts";
import * as THREE from "three";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createStudioViewerAPI } from "./studioApi";
import { getStudioSceneRuntime } from "./studioSceneRuntimeRegistry";

export interface TrustedApplicationScriptHost {
  application: ApplicationDocument;
  flow: InteractionFlow;
  source: ApplicationObjectRef;
  trigger: SceneInteractionTrigger;
  variables: Readonly<Record<string, JsonValue>>;
  engine?: ViewerEngine;
  resolveSceneRuntime?: (sceneId: string) => ViewerEngine | undefined;
  emitAction: (action: SceneInteractionActionState) => void;
  setData: (key: string, value: JsonValue) => void;
  updateComponent: (componentIdOrName: string, patch: Record<string, unknown>) => void;
  log?: (message: string, detail?: unknown) => void;
}

export async function runTrustedApplicationScript(host: TrustedApplicationScriptHost): Promise<void> {
  const script = host.flow.legacyScript?.script;
  if (!script?.enabled || !script.code.trim()) return;
  const application = structuredClone(host.application);
  const componentEntries = application.pages.flatMap((page) => page.nodes.map((node) => ({ page, node })));
  const objectEntries = application.scenes.flatMap((scene) => [...scene.models, ...scene.primitives].map((object) => ({ scene, object })));
  const emitObjectAction = (sceneId: string, modelId: string, type: SceneInteractionActionState["type"], options: Partial<SceneInteractionActionState> = {}) => host.emitAction({ id: crypto.randomUUID(), enabled: true, type, sceneId, target: { kind: "object", modelId }, ...options });
  const viewerApi = createStudioViewerAPI(host.engine, {
    ...(host.source.kind === "object" ? { sceneId: host.source.sceneId } : {}),
    emitAction: (action) => host.emitAction({ ...action, id: crypto.randomUUID(), enabled: true } as SceneInteractionActionState)
  });
  const objectHandle = (entry: typeof objectEntries[number]) => Object.freeze({
    ...entry.object,
    id: entry.object.modelId,
    sceneId: entry.scene.id,
    get raw() { return host.engine?.getRawObject(entry.object.modelId); },
    show: () => emitObjectAction(entry.scene.id, entry.object.modelId, "visibility", { value: "show" }),
    hide: () => emitObjectAction(entry.scene.id, entry.object.modelId, "visibility", { value: "hide" }),
    toggle: () => emitObjectAction(entry.scene.id, entry.object.modelId, "visibility", { value: "toggle" }),
    focus: () => emitObjectAction(entry.scene.id, entry.object.modelId, "focus"),
    setColor: (color: string) => emitObjectAction(entry.scene.id, entry.object.modelId, "color", { value: color }),
    setOpacity: (opacity: number) => emitObjectAction(entry.scene.id, entry.object.modelId, "opacity", { value: Math.max(0, Math.min(1, opacity)) }),
    getMaterial: () => entry.object.material ? structuredClone(entry.object.material) : undefined,
    setMaterial: () => {
      throw new Error("目标三维场景尚未加载；请先打开场景再修改材质");
    },
    playAnimation: () => emitObjectAction(entry.scene.id, entry.object.modelId, "animation", { value: "play" }),
    stopAnimation: () => emitObjectAction(entry.scene.id, entry.object.modelId, "animation", { value: "stop" })
  });
  const liveObjectHandle = (entry: typeof objectEntries[number]) => createStudioViewerAPI(
    host.resolveSceneRuntime ? host.resolveSceneRuntime(entry.scene.id) : getStudioSceneRuntime(entry.scene.id) ?? (host.source.kind === "object" && host.source.sceneId === entry.scene.id ? host.engine : undefined),
    { sceneId: entry.scene.id, emitAction: (action) => host.emitAction({ ...action, id: crypto.randomUUID(), enabled: true } as SceneInteractionActionState) }
  ).object(entry.object.modelId) ?? objectHandle(entry);
  const componentHandle = (entry: typeof componentEntries[number]) => Object.freeze({
    ...entry.node,
    pageId: entry.page.id,
    update: (patch: Record<string, unknown>) => host.updateComponent(entry.node.id, patch),
    show: () => host.updateComponent(entry.node.id, { visible: true }),
    hide: () => host.updateComponent(entry.node.id, { visible: false })
  });
  const studio = Object.freeze({
    ...viewerApi,
    application,
    pages: application.pages,
    scenes: application.scenes,
    topologies: application.topologies,
    source: structuredClone(host.source),
    trigger: host.trigger,
    engine: host.engine,
    raw: viewerApi.raw,
    query(selector: string) {
      const normalized = selector.trim().toLocaleLowerCase();
      return objectEntries.filter(({ object }) => object.modelId.toLocaleLowerCase() === normalized || object.name.toLocaleLowerCase().includes(normalized)).map(liveObjectHandle);
    },
    object(idOrName: string) {
      const normalized = idOrName.trim().toLocaleLowerCase();
      const entry = objectEntries.find(({ object }) => object.modelId.toLocaleLowerCase() === normalized || object.name.toLocaleLowerCase() === normalized);
      return entry ? liveObjectHandle(entry) : undefined;
    },
    objects(selector = "") {
      const normalized = selector.trim().toLocaleLowerCase();
      return objectEntries.filter(({ object }) => !normalized || object.modelId.toLocaleLowerCase().includes(normalized) || object.name.toLocaleLowerCase().includes(normalized)).map(liveObjectHandle);
    },
    component(idOrName: string) {
      const entry = componentEntries.find(({ node }) => node.id === idOrName || node.name === idOrName);
      return entry ? componentHandle(entry) : undefined;
    },
    components() {
      return componentEntries.map(componentHandle);
    },
    updateComponent: host.updateComponent,
    action(action: Omit<SceneInteractionActionState, "id" | "enabled"> & Partial<Pick<SceneInteractionActionState, "id" | "enabled">>) {
      host.emitAction({ ...action, id: action.id ?? crypto.randomUUID(), enabled: action.enabled !== false });
    },
    getData(key: string) {
      return host.variables[key];
    },
    setData: host.setData,
    scene: Object.freeze({
      ...viewerApi.scene,
      open(sceneId: string, newTab = false) {
        host.emitAction({ id: crypto.randomUUID(), enabled: true, type: "navigateScene", sceneId, newTab });
      }
    }),
    page: Object.freeze({
      open(dashboardPageId: string) {
        host.emitAction({ id: crypto.randomUUID(), enabled: true, type: "dashboard", dashboardPageId });
      }
    }),
    camera: Object.freeze({
      ...viewerApi.camera,
      applyView(cameraViewId: string, sceneId?: string) {
        host.emitAction({ id: crypto.randomUUID(), enabled: true, type: "cameraView", cameraViewId, ...(sceneId ? { sceneId } : {}) });
      }
    }),
    log: host.log ?? ((message: string, detail?: unknown) => console.info(`[Studio script] ${message}`, detail))
  });
  const context = Object.freeze({
    ...studio,
    event: Object.freeze({ type: host.trigger, timestamp: new Date().toISOString() })
  });
  const AsyncFunction = Object.getPrototypeOf(async function () { /* trusted application compiler */ }).constructor as new (...arguments_: string[]) => (...values: unknown[]) => Promise<unknown>;
  const execute = new AsyncFunction("ctx", "studio", "THREE", "app", "engine", `"use strict";\n${script.code}\n//# sourceURL=bim-studio-application-event-${script.id}.js`);
  await execute(context, studio, THREE, application, host.engine);
}
