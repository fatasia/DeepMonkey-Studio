import type { AgentMemoryRecord, AgentVerdictSummary } from "./agentMemory.js";

/**
 * Semantica 刀2「记忆冲突检测」：确定性冲突判定纯函数（零依赖、零向量语义）。
 *
 * 诚实边界：语义相悖判定只用确定性规则——指纹同域与理由码；不做向量/模型语义比较，
 * 判不出的永不误报。检测发生在写入路径（addMemoryCandidate / recordVerdict），
 * 结论是「标记冲突不阻断」：记录挂 conflictWith 元数据，冲突对进投递供 UI 呈现。
 *
 * 三条确定性规则：
 * ① verdict-polarity      同 proposalFingerprint 的判定翻供（前 confirmed 后 refuted 等）；
 * ② reason-code-reversal  同一理由码在不同提案上结论相反（理由码语义被污染的信号）；
 * ③ refuted-reassertion   新候选记忆与既有 active 记忆同指纹域，且该域已有 refuted 判定
 *                          （一方为被内核反驳方案的再主张，两记载相悖）。
 */

export type MemoryConflictKind = "verdict-polarity" | "reason-code-reversal" | "refuted-reassertion";

export interface MemoryConflictPair {
  kind: MemoryConflictKind;
  /** 冲突主题域：`fingerprint:<16hex>` 或 `code:<reasonCode>`。 */
  topic: string;
  /** 既有记录标识：判定用 `verdict:<resultFingerprint>`，记忆条目用其 id。 */
  withRecordId: string;
  detail: string;
}

/** 落盘/投递用的冲突登记条目（滚动窗口，旧落盘无此段按空数组读入）。 */
export interface AgentMemoryConflictEntry {
  id: string;
  kind: MemoryConflictKind;
  topic: string;
  /** 新写入记录的标识（记忆条目 id / `verdict:<resultFingerprint>`）。 */
  recordId: string;
  conflictWith: string[];
  detectedAt: string;
}

/** 单次写入登记的冲突对上限：检测是信号不是清单导出，超界截断降噪。 */
export const MEMORY_CONFLICT_PAIR_CAP = 4;
/** 冲突登记滚动窗口（每项目）。 */
export const AGENT_MEMORY_CONFLICT_MAX_RECORDS = 20;
/** 投递时随行返回的冲突对上限（UI 呈现用，不注入提示词）。 */
export const AGENT_MEMORY_CONFLICT_DELIVERY_MAX = 10;

const FINGERPRINT_PATTERN = /[0-9a-f]{16}/g;

/**
 * 确定性主题提取：origin.proposalFingerprint + 内容中出现的 16 位十六进制指纹 token。
 * 内容指纹匹配是启发式（自由文本里可能出现形似指纹的串），只用于标记不用于阻断，
 * 上限 8 个防原文是长十六进制串的病态输入。
 */
export function extractMemoryTopics(record: { originProposalFingerprint?: string | undefined; content?: string | undefined }): string[] {
  const topics = new Set<string>();
  if (record.originProposalFingerprint && /^[0-9a-f]{16}$/.test(record.originProposalFingerprint)) {
    topics.add(`fingerprint:${record.originProposalFingerprint}`);
  }
  const tokens = record.content?.toLowerCase().match(FINGERPRINT_PATTERN) ?? [];
  for (const token of tokens.slice(0, 8)) topics.add(`fingerprint:${token}`);
  return [...topics];
}

function memoryTopics(record: AgentMemoryRecord): string[] {
  return extractMemoryTopics({ originProposalFingerprint: record.origin.proposalFingerprint, content: record.content });
}

/**
 * verdict 回灌路径的冲突判定（在覆盖写入前，对既有判定窗口比对）：
 * ① 同 proposalFingerprint 不同 verdict → 翻供；
 * ② 不同 proposalFingerprint、同 reasonCode、不同 verdict → 理由码语义反转。
 */
export function detectVerdictConflicts(incoming: AgentVerdictSummary, existing: readonly AgentVerdictSummary[]): MemoryConflictPair[] {
  const pairs: MemoryConflictPair[] = [];
  for (const prior of existing) {
    if (prior.proposalFingerprint === incoming.proposalFingerprint) {
      if (prior.verdict !== incoming.verdict) {
        pairs.push({
          kind: "verdict-polarity",
          topic: `fingerprint:${incoming.proposalFingerprint}`,
          withRecordId: `verdict:${prior.resultFingerprint}`,
          detail: `同提案 ${incoming.proposalFingerprint} 判定翻供：${prior.verdict}（${prior.recordedAt}）→ ${incoming.verdict}；旧判定将被窗口覆盖，冲突对在此如实留痕`,
        });
      }
      continue;
    }
    if (prior.reasonCode === incoming.reasonCode && prior.verdict !== incoming.verdict) {
      pairs.push({
        kind: "reason-code-reversal",
        topic: `code:${incoming.reasonCode}`,
        withRecordId: `verdict:${prior.resultFingerprint}`,
        detail: `理由码 ${incoming.reasonCode} 在不同提案上结论相反：${prior.verdict}（提案 ${prior.proposalFingerprint}）vs ${incoming.verdict}；同码反义提示该理由码语义可能被污染`,
      });
    }
  }
  return pairs.slice(0, MEMORY_CONFLICT_PAIR_CAP);
}

/**
 * 记忆候选写入路径的冲突判定（对既有 active 记忆与判定窗口比对）：
 * 同指纹域的既有 active 记忆 × 该域 refuted 判定 → 新候选与旧记载相悖（refuted-reassertion）。
 * 判定必须确定性成立（域指纹相等 + 判定极性来自已落盘 verdict），不猜语义。
 */
export function detectMemoryCandidateConflicts(
  candidateTopics: readonly string[],
  activeMemories: readonly AgentMemoryRecord[],
  verdicts: readonly AgentVerdictSummary[],
): MemoryConflictPair[] {
  const refutedDomains = new Set(verdicts.filter((item) => item.verdict === "refuted").map((item) => `fingerprint:${item.proposalFingerprint}`));
  const pairs: MemoryConflictPair[] = [];
  const seen = new Set<string>();
  for (const topic of candidateTopics) {
    if (!refutedDomains.has(topic)) continue;
    for (const memory of activeMemories) {
      if (!memoryTopics(memory).includes(topic)) continue;
      const key = `${topic}|${memory.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        kind: "refuted-reassertion",
        topic,
        withRecordId: memory.id,
        detail: `主题域 ${topic} 已有 refuted 判定，既有生效记忆（${memory.id}）与新候选对同一方案的记载相悖；候选照常登记待确认，冲突对一并呈现供人工裁决`,
      });
    }
  }
  return pairs.slice(0, MEMORY_CONFLICT_PAIR_CAP);
}

/** 冲突登记条目的 fail-closed 形状过滤：坏行丢弃不回退（与既有段落同一纪律）。 */
export function isMemoryConflictEntry(value: unknown): value is AgentMemoryConflictEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AgentMemoryConflictEntry>;
  return typeof entry.id === "string"
    && (entry.kind === "verdict-polarity" || entry.kind === "reason-code-reversal" || entry.kind === "refuted-reassertion")
    && typeof entry.topic === "string"
    && typeof entry.recordId === "string"
    && Array.isArray(entry.conflictWith) && entry.conflictWith.every((item) => typeof item === "string")
    && typeof entry.detectedAt === "string";
}
