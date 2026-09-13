import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

export type ScriptRuntimeErrorCode = "INVALID_INPUT" | "EXECUTION_FAILED" | "TIMEOUT" | "OUTPUT_LIMIT";

export interface ScriptEmission {
  source?: string;
  key: string;
  value: unknown;
  sceneId?: string;
  target?: { modelId?: string; layerId?: string; annotationId?: string };
  action?: "color" | "visibility" | "position" | "label" | "opacity" | "focus" | "animation" | "effects" | "material" | "alarm";
}

export interface ScriptExecutionContext {
  variables?: Readonly<Record<string, unknown>>;
  now?: string;
}

export interface ScriptExecutionOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  maxOutputBytes?: number;
}

export interface ScriptExecutionResult<T = unknown> {
  output: T;
  emissions: ScriptEmission[];
  logs: string[];
  durationMs: number;
}

export class ScriptRuntimeError extends Error {
  constructor(message: string, readonly code: ScriptRuntimeErrorCode) {
    super(message);
    this.name = "ScriptRuntimeError";
  }
}

/**
 * Execute a synchronous JavaScript function body inside an isolated QuickJS VM.
 * The sandbox has no Node.js, filesystem, network, timer, DOM, or host globals.
 */
export async function executeDataScript<T = unknown>(source: string, input: unknown, context: ScriptExecutionContext = {}, options: ScriptExecutionOptions = {}): Promise<ScriptExecutionResult<T>> {
  if (!source.trim()) throw new ScriptRuntimeError("脚本不能为空", "INVALID_INPUT");
  const timeoutMs = clamp(options.timeoutMs ?? 100, 5, 2_000);
  const memoryLimitBytes = clamp(options.memoryLimitBytes ?? 8 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
  const maxStackSizeBytes = clamp(options.maxStackSizeBytes ?? 512 * 1024, 64 * 1024, 4 * 1024 * 1024);
  const maxOutputBytes = clamp(options.maxOutputBytes ?? 1024 * 1024, 1024, 8 * 1024 * 1024);
  const startedAt = performance.now();
  const quickJS = await getQuickJS();
  const program = buildProgram(source, input, context);

  try {
    const raw = quickJS.evalCode(program, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + timeoutMs),
      memoryLimitBytes,
      maxStackSizeBytes
    }) as Partial<ScriptExecutionResult<T>>;
    const serialized = JSON.stringify(raw);
    if (serialized.length > maxOutputBytes) throw new ScriptRuntimeError(`脚本输出超过 ${maxOutputBytes} 字节限制`, "OUTPUT_LIMIT");
    return {
      output: raw.output as T,
      emissions: normalizeEmissions(raw.emissions),
      logs: Array.isArray(raw.logs) ? raw.logs.slice(0, 100).map((value) => String(value).slice(0, 500)) : [],
      durationMs: performance.now() - startedAt
    };
  } catch (reason) {
    if (reason instanceof ScriptRuntimeError) throw reason;
    const details = errorDetails(reason);
    if (details.name === "InternalError" && details.message === "interrupted") throw new ScriptRuntimeError(`脚本执行超过 ${timeoutMs}ms`, "TIMEOUT");
    throw new ScriptRuntimeError(details.message || "脚本执行失败", "EXECUTION_FAILED");
  }
}

/** Execute one function body for every row inside a single isolated VM. */
export function executeRowScript<T = unknown>(source: string, rows: ReadonlyArray<Readonly<Record<string, unknown>>>, context: ScriptExecutionContext = {}, options: ScriptExecutionOptions = {}): Promise<ScriptExecutionResult<T[]>> {
  const rowProgram = `
    const __rowScript = (input, vars, emit, assert, log, now) => { "use strict"; ${source}\n };
    return input.rows.map((row, index, rows) => __rowScript(row, { ...vars, index, rows }, emit, assert, log, now));
  `;
  return executeDataScript<T[]>(rowProgram, { rows }, context, options);
}

function buildProgram(source: string, input: unknown, context: ScriptExecutionContext): string {
  const inputJson = safeJson(input, "输入");
  const variablesJson = safeJson(context.variables ?? {}, "变量");
  const now = context.now && Number.isFinite(Date.parse(context.now)) ? new Date(context.now).toISOString() : new Date().toISOString();
  return `
"use strict";
const __input = ${inputJson};
const __vars = ${variablesJson};
const __emissions = [];
const __logs = [];
const emit = (key, value, options = {}) => {
  if (typeof key !== "string" || !key.trim()) throw new Error("emit key 不能为空");
  __emissions.push({ key: key.trim(), value, ...options });
  return value;
};
const assert = (condition, message = "断言失败") => { if (!condition) throw new Error(String(message)); };
const log = (...values) => { if (__logs.length < 100) __logs.push(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ")); };
const __run = (input, vars, emit, assert, log, now) => { "use strict"; ${source}\n};
const __output = __run(__input, __vars, emit, assert, log, ${JSON.stringify(now)});
({ output: typeof __output === "undefined" ? null : __output, emissions: __emissions, logs: __logs });`;
}

function safeJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    return serialized.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  } catch {
    throw new ScriptRuntimeError(`${label}必须是可序列化 JSON`, "INVALID_INPUT");
  }
}

function normalizeEmissions(value: unknown): ScriptEmission[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const event = candidate as Partial<ScriptEmission>;
    if (!event.key?.trim() || !("value" in event)) return [];
    return [{ ...event, key: event.key.trim() } as ScriptEmission];
  });
}

function errorDetails(reason: unknown): { name?: string; message?: string } {
  if (reason instanceof Error) return reason;
  if (reason && typeof reason === "object") return reason as { name?: string; message?: string };
  return { message: String(reason) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}
