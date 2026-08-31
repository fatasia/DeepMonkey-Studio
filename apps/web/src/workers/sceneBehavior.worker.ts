/// <reference lib="webworker" />

import * as THREE from "three";
import type { DirectBindingSpec, DirectBindingTemplateValue, JsonValue } from "@bim-studio/contracts";
import type {
  SceneBehaviorModule,
  SceneBehaviorNetworkResult,
  SceneBehaviorTarget,
  SceneBehaviorWorkerRequest,
  SceneBehaviorWorkerResponse,
  SceneCommand,
  SceneMaterialCommandPatch,
  SceneScriptLifecycle
} from "@bim-studio/scene-sdk";

type LifecycleContext = {
  sceneId: string;
  target: SceneBehaviorTarget;
  self?: ReturnType<ReturnType<typeof createStudioApi>["object"]> | ReturnType<ReturnType<typeof createStudioApi>["component"]>;
  elapsedMs: number;
  deltaMs: number;
  elapsedTime: number;
  deltaTime: number;
  data?: unknown;
  event?: unknown;
  state: Record<string, unknown>;
  THREE: typeof THREE;
  studio: ReturnType<typeof createStudioApi>;
  net: ReturnType<typeof createNetworkApi>;
  object: ReturnType<typeof createStudioApi>["object"];
  command: (command: SceneCommand) => void;
  getData: (key: string) => JsonValue | undefined;
  setData: (key: string, value: JsonValue) => void;
  emit: (name: string, payload?: JsonValue) => void;
  log: (message: string, data?: unknown) => void;
};
type LifecycleHandler = (context: LifecycleContext) => unknown | Promise<unknown>;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: SceneBehaviorWorkerResponse) => workerScope.postMessage(message);
const scriptState: Record<string, unknown> = {};
const dataState: Record<string, JsonValue> = {};
let activeSceneId = "";
let activeInvocationId = "";
let activeCommands: SceneCommand[] | undefined;
let activeDataUpdates: Record<string, JsonValue> | undefined;
let activeEvents: Array<{ name: string; payload?: JsonValue }> | undefined;
let activeModule: SceneBehaviorModule | undefined;
let handlers: Partial<Record<SceneScriptLifecycle, LifecycleHandler>> = {};
let requestQueue = Promise.resolve();
const pendingNetwork = new Map<string, { resolve: (result: SceneBehaviorNetworkResult) => void; reject: (reason: Error) => void }>();

workerScope.onmessage = (event: MessageEvent<SceneBehaviorWorkerRequest>) => {
  if (event.data.type === "behavior.network.result") {
    settleNetworkResult(event.data);
    return;
  }
  requestQueue = requestQueue.then(() => handleRequest(event.data));
};

async function handleRequest(request: SceneBehaviorWorkerRequest): Promise<void> {
  try {
    if (request.type === "behavior.network.result") return;
    if (request.type === "behavior.initialize") {
      activeSceneId = request.sceneId;
      activeModule = request.module;
      for (const key of Object.keys(scriptState)) delete scriptState[key];
      for (const key of Object.keys(dataState)) delete dataState[key];
      handlers = await compileBehavior(request.module);
      send({ type: "behavior.ready", moduleId: request.module.id, lifecycle: request.module.lifecycle.filter((name) => typeof handlers[name] === "function") });
      return;
    }
    if (request.type === "behavior.dispose") {
      await invokeLifecycle("onDispose", request.invocationId, 0);
      handlers = {};
      activeSceneId = "";
      activeModule = undefined;
      rejectPendingNetwork("行为脚本已停止");
      return;
    }
    await invokeLifecycle(request.lifecycle, request.invocationId, request.elapsedMs, request.deltaMs, request.event, request.data);
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    send({ type: "behavior.error", ...("invocationId" in request ? { invocationId: request.invocationId } : {}), message: error.message, ...(error.stack ? { stack: error.stack } : {}) });
  }
}

async function invokeLifecycle(lifecycle: SceneScriptLifecycle, invocationId: string, elapsedMs: number, deltaMs = 0, event?: unknown, data?: unknown): Promise<void> {
  const commands: SceneCommand[] = [];
  const dataUpdates: Record<string, JsonValue> = {};
  const events: Array<{ name: string; payload?: JsonValue }> = [];
  if (isJsonRecord(data)) Object.assign(dataState, structuredClone(data));
  const startedAt = performance.now();
  const handler = handlers[lifecycle];
  if (handler) {
    activeInvocationId = invocationId;
    activeCommands = commands;
    activeDataUpdates = dataUpdates;
    activeEvents = events;
    const studio = createStudioApi();
    const net = createNetworkApi();
    const target = activeModule?.target ?? { kind: "scene" as const };
    const self = target.kind === "object" ? studio.object(target.id) : target.kind === "component" ? studio.component(target.id) : undefined;
    try {
      await handler(Object.freeze({
        sceneId: activeSceneId,
        target: Object.freeze(structuredClone(target)),
        ...(self ? { self } : {}),
        elapsedMs,
        deltaMs,
        elapsedTime: elapsedMs / 1_000,
        deltaTime: deltaMs / 1_000,
        ...(event !== undefined ? { event } : {}),
        ...(data !== undefined ? { data } : {}),
        state: scriptState,
        THREE,
        studio,
        net,
        object: studio.object,
        command: (command: SceneCommand) => commands.push(command),
        getData: (key: string) => getDataValue(key),
        setData: (key: string, value: JsonValue) => setDataValue(key, value),
        emit: (name: string, payload?: JsonValue) => emitEvent(name, payload),
        log
      }));
    } finally {
      activeCommands = undefined;
      activeDataUpdates = undefined;
      activeEvents = undefined;
      activeInvocationId = "";
    }
  }
  send({ type: "behavior.result", invocationId, durationMs: performance.now() - startedAt, commands, ...(Object.keys(dataUpdates).length ? { dataUpdates } : {}), ...(events.length ? { events } : {}) });
}

async function compileBehavior(module: SceneBehaviorModule): Promise<Partial<Record<SceneScriptLifecycle, LifecycleHandler>>> {
  const forbiddenHostAccess = /\b(?:window|document|localStorage|sessionStorage|indexedDB|caches|navigator|SharedWorker|Worker|importScripts|globalThis|self|eval|Function)\b|\bimport\s*\(/;
  const forbiddenNetworkAccess = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/;
  if (forbiddenHostAccess.test(module.code) || (!module.permissions.includes("network.connect") && forbiddenNetworkAccess.test(module.code))) {
    throw new Error("脚本请求了 Worker 沙箱中未授权的浏览器或网络能力");
  }
  const lifecycleNames: SceneScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
  const AsyncFunction = Object.getPrototypeOf(async function () { /* sandbox compiler */ }).constructor as new (...arguments_: string[]) => (...values: unknown[]) => Promise<unknown>;
  const studio = createStudioApi();
  const net = createNetworkApi();
  const proxyFetch = (endpoint: string, options?: StudioNetworkFetchOptions) => net.fetch(endpoint, options);
  const factory = new AsyncFunction("THREE", "studio", "net", "fetch", `"use strict";\n${module.code}\nreturn { ${lifecycleNames.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`).join(", ")} };\n//# sourceURL=industrial-studio-behavior-${module.id}.js`);
  return await factory(THREE, studio, net, proxyFetch) as Partial<Record<SceneScriptLifecycle, LifecycleHandler>>;
}

interface StudioNetworkFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | null>;
  body?: DirectBindingTemplateValue;
  credentialRef?: string;
  variables?: Record<string, DirectBindingTemplateValue>;
  select?: { jsonPath?: string; field?: string };
}

function createNetworkApi() {
  return Object.freeze({
    async request(binding: DirectBindingSpec, variables: Record<string, DirectBindingTemplateValue> = {}) {
      return requestNetwork(binding, variables);
    },
    async fetch(endpoint: string, options: StudioNetworkFetchOptions = {}) {
      const binding: DirectBindingSpec = {
        version: 1,
        gateway: "server",
        transport: "http",
        endpoint,
        ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
        ...(options.select ? { selection: options.select } : {}),
        http: {
          method: options.method ?? "GET",
          ...(options.params ? { params: options.params } : {}),
          ...(options.body !== undefined ? { bodyTemplate: options.body } : {}),
          refresh: { intervalMs: 60_000, immediate: true }
        }
      };
      return requestNetwork(binding, options.variables ?? {});
    }
  });
}

function requestNetwork(binding: DirectBindingSpec, variables: Record<string, DirectBindingTemplateValue>): Promise<SceneBehaviorNetworkResult> {
  if (!activeModule?.permissions.includes("network.connect")) return Promise.reject(new Error("脚本未声明 network.connect 权限"));
  if (!activeInvocationId) return Promise.reject(new Error("网络请求只能在行为生命周期函数中执行"));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingNetwork.set(requestId, { resolve, reject });
    send({ type: "behavior.network.request", requestId, invocationId: activeInvocationId, binding, variables });
  });
}

function createStudioApi() {
  const target = (objectId: string) => ({ kind: "object" as const, sceneId: activeSceneId, objectId });
  const emit = (command: SceneCommand) => {
    if (!activeCommands) throw new Error("studio API 只能在行为生命周期函数中调用");
    activeCommands.push(command);
  };
  const commandId = (name: string) => `${name}:${crypto.randomUUID()}`;
  const object = (objectId: string) => Object.freeze({
    id: objectId,
    show: () => emit({ id: commandId("show"), type: "object.set-visibility", target: target(objectId), visible: true }),
    hide: () => emit({ id: commandId("hide"), type: "object.set-visibility", target: target(objectId), visible: false }),
    select: () => emit({ id: commandId("select"), type: "selection.set", targets: [target(objectId)] }),
    focus: () => emit({ id: commandId("focus"), type: "camera.fly-to", sceneId: activeSceneId, target: target(objectId), durationMs: 0 }),
    setPosition: (x: number, y: number, z: number) => emit({ id: commandId("position"), type: "object.set-transform", target: target(objectId), position: [x, y, z] }),
    setRotation: (x: number, y: number, z: number) => emit({ id: commandId("rotation"), type: "object.set-transform", target: target(objectId), rotation: [x, y, z] }),
    setScale: (x: number, y = x, z = x) => emit({ id: commandId("scale"), type: "object.set-transform", target: target(objectId), scale: [x, y, z] }),
    setColor: (color: string) => emit({ id: commandId("color"), type: "data.apply", target: target(objectId), values: { color }, timestamp: new Date().toISOString() }),
    setOpacity: (opacity: number) => emit({ id: commandId("opacity"), type: "data.apply", target: target(objectId), values: { opacity }, timestamp: new Date().toISOString() }),
    setMaterial: (patch: SceneMaterialCommandPatch) =>
      emit({ id: commandId("material"), type: "material.set", target: target(objectId), patch }),
    playAnimation: (clipName?: string) => emit({ id: commandId("animation"), type: "animation.control", target: target(objectId), action: "play", ...(clipName ? { clipId: clipName } : {}) }),
    pauseAnimation: (clipName?: string) => emit({ id: commandId("animation"), type: "animation.control", target: target(objectId), action: "pause", ...(clipName ? { clipId: clipName } : {}) }),
    stopAnimation: (clipName?: string) => emit({ id: commandId("animation"), type: "animation.control", target: target(objectId), action: "stop", ...(clipName ? { clipId: clipName } : {}) }),
    seekAnimation: (seconds: number, clipName?: string) => emit({ id: commandId("animation"), type: "animation.control", target: target(objectId), action: "seek", time: seconds, ...(clipName ? { clipId: clipName } : {}) })
  });
  const component = (componentId: string) => Object.freeze({
    id: componentId,
    update: (patch: Record<string, JsonValue>) => emit({ id: commandId("component"), type: "component.update", componentId, patch }),
    show: () => emit({ id: commandId("component"), type: "component.update", componentId, patch: { visible: true } }),
    hide: () => emit({ id: commandId("component"), type: "component.update", componentId, patch: { visible: false } }),
    rename: (name: string) => emit({ id: commandId("component"), type: "component.update", componentId, patch: { name } })
  });
  const unity = (componentId: string) => Object.freeze({
    id: componentId,
    setProperty: (key: string, value: JsonValue) => emit({ id: commandId("unity-property"), type: "unity.properties.set", componentId, values: { [key]: value } }),
    setProperties: (values: Record<string, JsonValue>) => emit({ id: commandId("unity-properties"), type: "unity.properties.set", componentId, values }),
    invoke: (action: string, objectId?: string, value?: JsonValue) => emit({
      id: commandId("unity-action"), type: "unity.action.invoke", componentId, action,
      ...(objectId ? { objectId } : {}), ...(value === undefined ? {} : { value })
    }),
    switchScene: (scene: string) => emit({ id: commandId("unity-scene"), type: "unity.scene.switch", componentId, scene })
  });
  return Object.freeze({
    version: "1.0" as const,
    THREE,
    net: createNetworkApi(),
    object,
    component,
    unity,
    getData: (key: string) => getDataValue(key),
    setData: (key: string, value: JsonValue) => setDataValue(key, value),
    emit: (name: string, payload?: JsonValue) => emitEvent(name, payload),
    camera: Object.freeze({
      setPose: (position: [number, number, number], targetPosition: [number, number, number], options: { near?: number; far?: number; fov?: number } = {}) => emit({ id: commandId("camera"), type: "camera.set", sceneId: activeSceneId, position, target: targetPosition, ...options }),
      focus: (objectId: string) => object(objectId).focus()
    }),
    selection: Object.freeze({ clear: () => emit({ id: commandId("selection"), type: "selection.set", targets: [] }) }),
    log
  });
}

function setDataValue(key: string, value: JsonValue): void {
  if (!activeModule?.permissions.includes("data.write")) throw new Error("脚本未声明 data.write 权限");
  if (!activeDataUpdates) throw new Error("setData 只能在行为生命周期函数中调用");
  const cloned = structuredClone(value);
  dataState[key] = cloned;
  activeDataUpdates[key] = cloned;
}

function getDataValue(key: string): JsonValue | undefined {
  if (!activeModule?.permissions.includes("data.read")) throw new Error("脚本未声明 data.read 权限");
  return dataState[key];
}

function emitEvent(name: string, payload?: JsonValue): void {
  if (!activeEvents) throw new Error("emit 只能在行为生命周期函数中调用");
  const normalized = name.trim();
  if (!normalized) throw new Error("事件名称不能为空");
  activeEvents.push({ name: normalized, ...(payload === undefined ? {} : { payload: structuredClone(payload) }) });
}

function log(message: string, payload?: unknown) {
  send({ type: "behavior.log", level: "info", message: String(message), ...(isJsonValue(payload) ? { data: payload } : {}) });
}

function rejectPendingNetwork(message: string) {
  for (const pending of pendingNetwork.values()) pending.reject(new Error(message));
  pendingNetwork.clear();
}

function settleNetworkResult(request: Extract<SceneBehaviorWorkerRequest, { type: "behavior.network.result" }>) {
  const pending = pendingNetwork.get(request.requestId);
  if (!pending) return;
  pendingNetwork.delete(request.requestId);
  if (request.result) pending.resolve(request.result);
  else pending.reject(new Error(request.error || "网络网关请求失败"));
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is import("@bim-studio/contracts").JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return typeof value !== "number" || Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.entries(value).every(([key, item]) => typeof key === "string" && isJsonValue(item, seen));
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value));
}

export {};
