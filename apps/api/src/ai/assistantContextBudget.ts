import { createHash } from "node:crypto";
import type { AiContextBudgetReport } from "@bim-studio/contracts";

/**
 * 助手上下文预算器：按优先级裁剪、可解释、语义安全（只在 JSON 值层面缩减，不切断结构）。
 *
 * 优先级（保留顺序，高→低）：系统指令 > 当前问题 > 选中对象/场景/对话（focus）> 记忆 > 实验档案/平台数据（archive）> 能力目录。
 * 裁剪顺序与之相反，但能力目录"索引"体积很小且字节稳定（缓存前缀的一部分），只在 archive 与 memory
 * 都已压到底仍超限时才丢弃，且早于 focus 缩减。
 *
 * 缓存友好排序（静态→慢变→易变）：能力目录索引/边界/provider → 记忆 → platform → 其他字段 → focus → 按需 schema → 裁剪说明。
 * 同一会话内前三段字节稳定，provider 的自动前缀缓存才能命中。
 */

export const DEFAULT_ASSISTANT_CONTEXT_BUDGET_CHARS = 24_000;
export const MIN_ASSISTANT_CONTEXT_BUDGET_CHARS = 8_000;
export const MAX_ASSISTANT_CONTEXT_BUDGET_CHARS = 120_000;
/** 触发裁剪时给 `contextBudget` 说明预留的字符数。 */
const NOTICE_RESERVE = 900;
/** archive 超限时，为易变 focus 预留的比例：focus 小于该预留时 archive 的裁剪量与 focus 无关，保证前缀稳定。 */
const FOCUS_RESERVE_RATIO = 0.15;
const MIN_CONTEXT_CHARS = 2_000;

export const CAPABILITY_BOUNDARY = "目录仅表示可调用；未返回 capabilityResult 前不得声称已经执行";

const MEMORY_KEYS = ["agentMemoryContext"] as const;
const FOCUS_ORDER = ["project", "currentView", "workspace", "scene", "selected", "dashboard", "script", "simulation", "bimEvidence", "recentConversation", "contextTrust"] as const;
const FOCUS_KEYS: ReadonlySet<string> = new Set(FOCUS_ORDER);
const STATIC_KEYS: ReadonlySet<string> = new Set(["availableCapabilities", "capabilityBoundary", "aiProvider"]);
const RESERVED_OUTPUT_KEYS: ReadonlySet<string> = new Set(["availableCapabilityDetails", "contextBudget"]);
const TAIL_KEYS: ReadonlySet<string> = new Set(["recentConversation"]);
const MEMORY_PROTECTED: ReadonlySet<string> = new Set(["rules", "priority", "delivery"]);
const GENERIC_CAPABILITY_QUESTION = /能力|capabilit|schema|参数|入参|输入|调用|怎么用|如何用|能做什么|可以做什么|有哪些工具|\btools?\b/i;
const MAX_NAMED_DETAILS = 4;
/** 按需 schema 在超限时最多占上下文上限的比例。 */
const DETAILS_SHARE = 0.35;

const PLATFORM_SOURCE_IDS: Record<string, string> = { operations: "operations", processPlanning: "ppr-bop", battery: "battery" };

type Dict = Record<string, unknown>;
interface CatalogItem { id?: unknown; label?: unknown; kind?: unknown; inputSchemaVersion?: unknown; inputSchema?: unknown; decisionBoundary?: unknown }
type TrimEntry = AiContextBudgetReport["trimmed"][number];

export interface AssistantContextBudgetInput {
  context: Dict;
  question: string;
  /** 系统指令 + 问题 + 固定包装已占用的字符数。 */
  fixedChars: number;
  /** 提示词总预算（字符）；缺省取 resolveAssistantContextBudget()。 */
  budgetChars?: number;
}

export interface AssistantContextBudgetResult {
  context: Dict;
  /** 重排并完成能力目录索引化、但尚未做任何超限裁剪的上下文——交付回执的 prepared 口径（索引化不算"部分发送"）。 */
  shaped: Dict;
  report: AiContextBudgetReport;
  /** 预算器可用的上下文字符上限（含说明预留之前），供调用方做最终保险截断。 */
  contextLimit: number;
  /** 是否发生了会改变模型所见数据的裁剪（不含能力 schema 的按需展开）。 */
  dataTrimmed: boolean;
  /** 面向用户的裁剪说明；仅在 dataTrimmed 时存在。 */
  warning?: string;
}

/** AI_CONTEXT_BUDGET_CHARS 覆盖默认 24k；非法值回落默认，范围夹在 [8k, 120k]。 */
export function resolveAssistantContextBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AI_CONTEXT_BUDGET_CHARS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ASSISTANT_CONTEXT_BUDGET_CHARS;
  return Math.min(MAX_ASSISTANT_CONTEXT_BUDGET_CHARS, Math.max(MIN_ASSISTANT_CONTEXT_BUDGET_CHARS, Math.floor(raw)));
}

/**
 * 注入扫描（prepareAiInput）按键顺序消耗"来源数/文本量"额度；把高优先级字段排在前面，
 * 额度耗尽时被替换成 `{truncated:true}` 的就是 platform 的尾部而不是当前对话与证据。
 */
export function prioritizeContextForScan(context: unknown): unknown {
  if (!isRecord(context)) return context;
  const rank = (key: string) => {
    const focus = FOCUS_ORDER.indexOf(key as (typeof FOCUS_ORDER)[number]);
    if (focus >= 0) return focus;
    if ((MEMORY_KEYS as readonly string[]).includes(key)) return 20;
    return key === "platform" ? 40 : 30;
  };
  return Object.fromEntries(Object.entries(context).map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.index - b.index).map((item) => item.entry));
}

/** provider 缓存路由提示：同项目同模式稳定，不含任何用户内容。 */
export function promptCacheKey(projectId: string | undefined, mode: string): string {
  return `bim-assistant:${createHash("sha256").update(`${projectId ?? "-"}|${mode}`).digest("hex").slice(0, 24)}`;
}

export function budgetAssistantContext(input: AssistantContextBudgetInput): AssistantContextBudgetResult {
  const budget = input.budgetChars ?? resolveAssistantContextBudget();
  const base = Math.max(MIN_CONTEXT_CHARS, budget - input.fixedChars);
  const source = input.context;
  const trimmed: TrimEntry[] = [];
  const originalChars = size(source);

  const catalog = Array.isArray(source.availableCapabilities) ? shapeCatalog(source.availableCapabilities as CatalogItem[], input.question) : undefined;
  let statics: Dict = {};
  if (catalog) statics.availableCapabilities = catalog.index;
  if (catalog || "capabilityBoundary" in source) statics.capabilityBoundary = CAPABILITY_BOUNDARY;
  if ("aiProvider" in source) statics.aiProvider = source.aiProvider;
  let memory: Dict = pick(source, MEMORY_KEYS);
  const archiveSource: Dict = {};
  if ("platform" in source) archiveSource.platform = source.platform;
  for (const [key, value] of Object.entries(source)) {
    if (STATIC_KEYS.has(key) || (MEMORY_KEYS as readonly string[]).includes(key) || FOCUS_KEYS.has(key) || key === "platform" || RESERVED_OUTPUT_KEYS.has(key)) continue;
    archiveSource[key] = value;
  }
  let archive: Dict = archiveSource;
  let focus: Dict = pick(source, FOCUS_ORDER);
  let details: Dict = catalog?.details.length ? { availableCapabilityDetails: catalog.details } : {};

  const shaped: Dict = { ...statics, ...memory, ...archive, ...focus, ...details };
  const total = () => 2 + body(statics) + body(memory) + body(archive) + body(focus) + body(details);
  let limit = base;
  let dataTrimmed = false;
  const dataTrims: TrimEntry[] = [];
  const track = (before: Dict, after: Dict, reason: string) => {
    const entries = diffTrim(before, after, reason);
    dataTrims.push(...entries);
    if (entries.length) dataTrimmed = true;
  };

  if (total() > limit) {
    limit = Math.max(MIN_CONTEXT_CHARS, base - NOTICE_RESERVE);
    // 被问题点名/询问的 schema 是回答所需，按 focus 计价，但最多占上限的一部分，整项保留。
    if (details.availableCapabilityDetails) {
      details = { availableCapabilityDetails: shrinkTo(details.availableCapabilityDetails, Math.round(limit * DETAILS_SHARE), {}) };
    }
    const focusHold = Math.max(body(focus) + body(details), Math.round(limit * FOCUS_RESERVE_RATIO));
    const archiveCap = Math.max(0, limit - 2 - body(statics) - body(memory) - focusHold);
    if (body(archive) > archiveCap) {
      const next = shrinkTo(archive, archiveCap, {}) as Dict;
      track(archive, next, "over-budget:archive");
      archive = next;
    }
    if (total() > limit) {
      const memoryCap = Math.max(0, limit - 2 - body(statics) - body(focus) - body(details) - body(archive));
      const next: Dict = {};
      for (const [key, value] of Object.entries(memory)) {
        next[key] = shrinkTo(value, Math.max(0, memoryCap - JSON.stringify(key).length - 3), { protect: MEMORY_PROTECTED });
      }
      track(memory, next, "over-budget:memory");
      memory = next;
    }
    if (total() > limit && statics.availableCapabilities) {
      const { availableCapabilities: _index, ...rest } = statics;
      statics = rest;
    }
    if (total() > limit) {
      details = {};
      const focusCap = Math.max(0, limit - 2 - body(statics) - body(memory) - body(archive));
      const next = shrinkTo(focus, focusCap, { tail: TAIL_KEYS }) as Dict;
      track(focus, next, "over-budget:focus");
      focus = next;
    }
  }

  if (catalog) {
    const from = size(source.availableCapabilities);
    const to = size(statics.availableCapabilities) + size(details.availableCapabilityDetails);
    const keptDetails = (details.availableCapabilityDetails as unknown[] | undefined)?.length ?? 0;
    if (!statics.availableCapabilities) trimmed.push({ id: "capability-catalog", action: "omitted", fromChars: from, toChars: to, reason: "over-budget:catalog" });
    else if (to < from) {
      const reason = !keptDetails ? "index-only" : keptDetails < catalog.details.length ? "index-with-partial-schemas" : "index-with-matched-schemas";
      trimmed.push({ id: "capability-catalog", action: "compacted", fromChars: from, toChars: to, reason });
    }
  }
  const notice: Dict = dataTrimmed ? {
    contextBudget: {
      note: "上下文超出预算，下列来源已被缩减或省略；回答时不得把缺失部分当作不存在，应提示用户缩小范围。",
      trimmed: dataTrims.slice(0, 8).map(({ id, action, fromChars, toChars }) => ({ id, action, fromChars, toChars })),
    },
  } : {};
  const context: Dict = { ...statics, ...memory, ...archive, ...focus, ...details, ...notice };
  const usedChars = size(context);
  const report: AiContextBudgetReport = { budgetChars: budget, originalChars, usedChars, trimmed: [...trimmed, ...dataTrims] };
  return {
    context, shaped, report, contextLimit: base, dataTrimmed,
    ...(dataTrimmed ? { warning: `上下文已按 ${budget} 字符预算压缩：${dataTrims.slice(0, 6).map((item) => `${item.id} ${item.fromChars}→${item.toChars}`).join("、")}${dataTrims.length > 6 ? " 等" : ""}；被缩减的来源只发送了一部分，不能据此判断其余内容缺失。` } : {}),
  };
}

/** 索引（id/label/kind/schema 版本）静态稳定；schema 只在问题点名某能力或询问"能力/参数"时按需展开。 */
function shapeCatalog(items: CatalogItem[], question: string): { index: unknown[]; details: Array<{ id: unknown; inputSchema: unknown }> } {
  const sorted = [...items].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const index = sorted.map(({ id, label, kind, inputSchemaVersion }) => ({ id, label, kind, inputSchemaVersion }));
  const withSchema = sorted.filter((item) => item.inputSchema !== undefined);
  const asked = question.toLowerCase();
  const selected = GENERIC_CAPABILITY_QUESTION.test(question)
    ? [...withSchema].sort((a, b) => size(a.inputSchema) - size(b.inputSchema))
    : withSchema.filter((item) => mentions(asked, item)).slice(0, MAX_NAMED_DETAILS);
  return { index, details: selected.map((item) => ({ id: item.id, inputSchema: item.inputSchema })) };
}

function mentions(question: string, item: CatalogItem): boolean {
  const id = typeof item.id === "string" ? item.id.toLowerCase() : "";
  if (id && question.includes(id)) return true;
  if (id.split(/[.\-_]/).some((part) => part.length >= 5 && question.includes(part))) return true;
  const label = typeof item.label === "string" ? item.label.toLowerCase() : "";
  return label.length >= 2 && (question.includes(label) || label.split(/[\s·\-—/（）()]+/).some((part) => part.length >= 3 && question.includes(part)));
}

interface ShrinkOptions { protect?: ReadonlySet<string>; tail?: ReadonlySet<string> }

/** 把 JSON 值缩到不超过 target 个序列化字符；结构始终合法，数组按整项保留，字符串带截断标记。 */
function shrinkTo(value: unknown, target: number, options: ShrinkOptions, key?: string): unknown {
  if (size(value) <= target) return value;
  if (typeof value === "string") return shrinkString(value, target);
  if (Array.isArray(value)) return shrinkArray(value, target, Boolean(key && options.tail?.has(key)), options);
  if (isRecord(value)) return shrinkObject(value, target, options);
  return value;
}

function shrinkString(value: string, target: number): string {
  const marker = `…[已截断，原${value.length}字符]`;
  if (target < marker.length + 4) return "";
  let keep = target - 2 - marker.length;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let cut = value.slice(0, Math.max(0, keep));
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    const result = `${cut}${marker}`;
    const overflow = size(result) - target;
    if (overflow <= 0) return result;
    keep -= overflow;
  }
  return "";
}

function shrinkArray(items: unknown[], target: number, keepTail: boolean, options: ShrinkOptions): unknown[] {
  const budget = target - 2;
  if (budget <= 0) return [];
  const ordered = keepTail ? [...items].reverse() : items;
  const kept: unknown[] = [];
  let used = 0;
  for (const item of ordered) {
    const next = size(item) + 1;
    if (used + next > budget) break;
    kept.push(item);
    used += next;
  }
  if (!kept.length && ordered.length && budget >= 24) {
    const partial = shrinkTo(ordered[0], budget - 1, { ...(options.tail ? { tail: options.tail } : {}) });
    if (size(partial) + 1 <= budget) kept.push(partial);
  }
  return keepTail ? kept.reverse() : kept;
}

function shrinkObject(record: Dict, target: number, options: ShrinkOptions): Dict {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  const overhead = entries.reduce((sum, [key]) => sum + JSON.stringify(key).length + 2, 2);
  let room = Math.max(0, target - overhead);
  const result: Dict = {};
  const protectedEntries = entries.filter(([key]) => options.protect?.has(key));
  const flexible = entries.filter(([key]) => !options.protect?.has(key));
  const protectedSize = protectedEntries.reduce((sum, [, value]) => sum + size(value), 0);
  const childOptions: ShrinkOptions = options.tail ? { tail: options.tail } : {};
  if (protectedSize <= room) {
    for (const [key, value] of protectedEntries) result[key] = value;
    room -= protectedSize;
  } else {
    const caps = waterFill(protectedEntries.map(([, value]) => size(value)), room);
    protectedEntries.forEach(([key, value], index) => { result[key] = shrinkTo(value, caps[index]!, childOptions, key); });
    room = 0;
  }
  const sizes = flexible.map(([, value]) => size(value));
  const caps = waterFill(sizes, room);
  const shrunk: unknown[] = flexible.map(([key, value], index) => shrinkTo(value, caps[index]!, childOptions, key));
  // 数组按整项保留会留下未用额度：把剩余额度均分给仍被缩减的项再试，最多三轮。
  for (let pass = 0; pass < 3; pass += 1) {
    const leftover = room - shrunk.reduce<number>((sum, value) => sum + size(value), 0);
    const cut = shrunk.map((value, index) => (size(value) < sizes[index]! ? index : -1)).filter((index) => index >= 0);
    const share = cut.length ? Math.floor(leftover / cut.length) : 0;
    if (share < 1) break;
    for (const index of cut) {
      const retry = shrinkTo(flexible[index]![1], size(shrunk[index]) + share, childOptions, flexible[index]![0]);
      if (size(retry) >= size(shrunk[index])) shrunk[index] = retry;
    }
  }
  flexible.forEach(([key], index) => { result[key] = shrunk[index]; });
  // 保持原键顺序，避免因裁剪改变字节布局。
  return Object.fromEntries(entries.map(([key]) => [key, result[key]]));
}

/** 公平分配：小项先按原样满足，剩余额度由大项均分。 */
function waterFill(sizes: number[], budget: number): number[] {
  const order = sizes.map((_, index) => index).sort((a, b) => sizes[a]! - sizes[b]!);
  const caps = new Array<number>(sizes.length).fill(0);
  let remaining = Math.max(0, budget);
  order.forEach((index, rank) => {
    const share = Math.floor(remaining / (order.length - rank));
    const cap = Math.min(sizes[index]!, share);
    caps[index] = cap;
    remaining -= cap;
  });
  return caps;
}

function diffTrim(before: Dict, after: Dict, reason: string): TrimEntry[] {
  const entries: TrimEntry[] = [];
  for (const [key, value] of Object.entries(before)) {
    const next = after[key];
    const from = size(value);
    const to = size(next);
    if (to >= from) continue;
    if (key === "platform" && isRecord(value) && isRecord(next)) {
      for (const [child, childValue] of Object.entries(value)) {
        const childFrom = size(childValue);
        const childTo = size(next[child]);
        if (childTo < childFrom) entries.push(entry(PLATFORM_SOURCE_IDS[child] ?? `platform.${child}`, childFrom, childTo, reason));
      }
      continue;
    }
    entries.push(entry(key === "agentMemoryContext" ? "agent-memory-context" : key, from, to, reason));
  }
  return entries;
}

function entry(id: string, fromChars: number, toChars: number, reason: string): TrimEntry {
  return { id, action: toChars <= 2 ? "omitted" : "shrunk", fromChars, toChars, reason };
}

function pick(source: Dict, keys: readonly string[]): Dict {
  const result: Dict = {};
  for (const key of keys) if (key in source && source[key] !== undefined) result[key] = source[key];
  return result;
}

function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** 分组对象在最终对象里的字符贡献（含与后续键之间的逗号），空组为 0。 */
function body(group: Dict): number {
  const text = JSON.stringify(group);
  return !text || text === "{}" ? 0 : text.length - 1;
}

function isRecord(value: unknown): value is Dict {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
