import type { JsonValue } from "@bim-studio/contracts";
import type {
  SceneBehaviorWorkerResponse,
  SceneScriptLifecycle,
} from "@bim-studio/scene-sdk";

const LIFECYCLES = new Set<SceneScriptLifecycle>([
  "onStart",
  "onUpdate",
  "onFixedUpdate",
  "onData",
  "onEvent",
  "onStop",
  "onDispose",
]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export function isWorkerResponse(value: unknown): value is SceneBehaviorWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "behavior.ready") {
    return (
      typeof message.moduleId === "string" &&
      Array.isArray(message.lifecycle) &&
      message.lifecycle.every((item) => LIFECYCLES.has(item as SceneScriptLifecycle))
    );
  }
  if (message.type === "behavior.result") {
    return (
      typeof message.invocationId === "string" &&
      typeof message.durationMs === "number" &&
      Number.isFinite(message.durationMs) &&
      message.durationMs >= 0 &&
      Array.isArray(message.commands) &&
      (message.dataUpdates === undefined || isJsonRecord(message.dataUpdates)) &&
      (message.events === undefined ||
        (Array.isArray(message.events) && message.events.every(isBehaviorEvent)))
    );
  }
  if (message.type === "behavior.network.request") {
    return (
      typeof message.requestId === "string" &&
      typeof message.invocationId === "string" &&
      Boolean(message.binding && typeof message.binding === "object") &&
      Boolean(message.variables && typeof message.variables === "object")
    );
  }
  if (message.type === "behavior.capability.request") {
    return (
      typeof message.requestId === "string" &&
      typeof message.invocationId === "string" &&
      typeof message.capabilityId === "string" &&
      message.capabilityId.trim().length > 0 &&
      isJsonValue(message.input)
    );
  }
  if (message.type === "behavior.log") {
    return (
      typeof message.level === "string" &&
      LOG_LEVELS.has(message.level) &&
      typeof message.message === "string"
    );
  }
  if (message.type === "behavior.error") {
    return (
      typeof message.message === "string" &&
      (message.invocationId === undefined || typeof message.invocationId === "string") &&
      (message.location === undefined || isSourceLocation(message.location))
    );
  }
  return false;
}

function isSourceLocation(value: unknown): value is { line: number; column: number } {
  if (!value || typeof value !== "object") return false;
  const location = value as Record<string, unknown>;
  return Number.isInteger(location.line) && Number(location.line) >= 1 && Number.isInteger(location.column) && Number(location.column) >= 1;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}

function isBehaviorEvent(value: unknown): value is { name: string; payload?: JsonValue } {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.name === "string" &&
    event.name.trim().length > 0 &&
    (event.payload === undefined || isJsonValue(event.payload))
  );
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

export function behaviorSourceLocationFromOffset(source: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(source.length, offset));
  const prefix = source.slice(0, boundedOffset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.split("\n").length, column: boundedOffset - lineStart + 1 };
}

export function behaviorSourceLocation(
  stack: string | undefined,
  moduleId: string | undefined,
): { line: number; column: number } | undefined {
  if (!stack || !moduleId) return undefined;
  const sourceId = encodeURIComponent(moduleId);
  const isModule = stack.includes(`industrial-studio-behavior-${sourceId}.mjs:`);
  const marker = `industrial-studio-behavior-${sourceId}.${isModule ? "mjs" : "js"}:`;
  const start = stack.indexOf(marker);
  if (start < 0) return undefined;
  const match = /^(\d+):(\d+)/.exec(stack.slice(start + marker.length));
  if (!match) return undefined;
  const generatedLine = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isInteger(generatedLine) || !Number.isInteger(column)) return undefined;
  return {
    line: Math.max(1, generatedLine - (isModule ? 2 : 3)),
    column: Math.max(1, column),
  };
}
