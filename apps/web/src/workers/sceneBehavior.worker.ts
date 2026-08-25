/// <reference lib="webworker" />

import type {
  SceneBehaviorModule,
  SceneBehaviorWorkerRequest,
  SceneBehaviorWorkerResponse,
  SceneCommand,
  SceneScriptLifecycle
} from "@bim-studio/scene-sdk";

type LifecycleContext = {
  sceneId: string;
  elapsedMs: number;
  deltaMs: number;
  event?: unknown;
  data?: unknown;
  state: Record<string, unknown>;
  command: (command: SceneCommand) => void;
  log: (message: string, data?: unknown) => void;
};
type LifecycleHandler = (context: LifecycleContext) => unknown | Promise<unknown>;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const send = (message: SceneBehaviorWorkerResponse) => workerScope.postMessage(message);
const scriptState: Record<string, unknown> = {};
let activeSceneId = "";
let handlers: Partial<Record<SceneScriptLifecycle, LifecycleHandler>> = {};
let requestQueue = Promise.resolve();

workerScope.onmessage = (event: MessageEvent<SceneBehaviorWorkerRequest>) => {
  requestQueue = requestQueue.then(() => handleRequest(event.data));
};

async function handleRequest(request: SceneBehaviorWorkerRequest): Promise<void> {
  try {
    if (request.type === "behavior.initialize") {
      activeSceneId = request.sceneId;
      for (const key of Object.keys(scriptState)) delete scriptState[key];
      handlers = await compileBehavior(request.module);
      send({ type: "behavior.ready", moduleId: request.module.id, lifecycle: request.module.lifecycle.filter((name) => typeof handlers[name] === "function") });
      return;
    }
    if (request.type === "behavior.dispose") {
      await invokeLifecycle("onDispose", request.invocationId, 0);
      handlers = {};
      activeSceneId = "";
      return;
    }
    await invokeLifecycle(request.lifecycle, request.invocationId, request.elapsedMs, request.deltaMs, request.event, request.data);
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    send({ type: "behavior.error", ...(request.type !== "behavior.initialize" ? { invocationId: request.invocationId } : {}), message: error.message, ...(error.stack ? { stack: error.stack } : {}) });
  }
}

async function invokeLifecycle(lifecycle: SceneScriptLifecycle, invocationId: string, elapsedMs: number, deltaMs = 0, event?: unknown, data?: unknown): Promise<void> {
  const commands: SceneCommand[] = [];
  const startedAt = performance.now();
  const handler = handlers[lifecycle];
  if (handler) {
    await handler(Object.freeze({
      sceneId: activeSceneId,
      elapsedMs,
      deltaMs,
      ...(event !== undefined ? { event } : {}),
      ...(data !== undefined ? { data } : {}),
      state: scriptState,
      command: (command: SceneCommand) => commands.push(command),
      log: (message: string, payload?: unknown) => send({ type: "behavior.log", level: "info", message: String(message), ...(isJsonValue(payload) ? { data: payload } : {}) })
    }));
  }
  send({ type: "behavior.result", invocationId, durationMs: performance.now() - startedAt, commands });
}

async function compileBehavior(module: SceneBehaviorModule): Promise<Partial<Record<SceneScriptLifecycle, LifecycleHandler>>> {
  const forbiddenHostAccess = /\b(?:window|document|localStorage|sessionStorage|indexedDB|caches|navigator|SharedWorker|Worker|importScripts|globalThis|self|eval|Function)\b|\bimport\s*\(/;
  const forbiddenNetworkAccess = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/;
  if (forbiddenHostAccess.test(module.code) || (!module.permissions.includes("network.connect") && forbiddenNetworkAccess.test(module.code))) {
    throw new Error("脚本请求了 Worker 沙箱中未授权的浏览器或网络能力");
  }
  const lifecycleNames: SceneScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
  const AsyncFunction = Object.getPrototypeOf(async function () { /* sandbox compiler */ }).constructor as new (...arguments_: string[]) => (...values: unknown[]) => Promise<unknown>;
  const factory = new AsyncFunction(`"use strict";\n${module.code}\nreturn { ${lifecycleNames.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`).join(", ")} };\n//# sourceURL=bim-studio-behavior-${module.id}.js`);
  return await factory() as Partial<Record<SceneScriptLifecycle, LifecycleHandler>>;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is import("@bim-studio/contracts").JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return typeof value !== "number" || Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.entries(value).every(([key, item]) => typeof key === "string" && isJsonValue(item, seen));
}

export {};
