import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import {
  AGENT_MEMORY_CONFLICT_DELIVERY_MAX,
  AGENT_MEMORY_CONFLICT_MAX_RECORDS,
  detectMemoryCandidateConflicts,
  detectVerdictConflicts,
  extractMemoryTopics,
  isMemoryConflictEntry,
  type AgentMemoryConflictEntry,
  type MemoryConflictPair,
} from "./memoryConflicts.js";

/**
 * H-C2 记忆系统三层（增强 2 + 用户"可感知"硬要求）：
 * ① 守则层：data-dir 下 agent-memory/<projectId>/RULES.md，人写、只读注入；
 * ② 偏好层：agent 从会话提炼候选（pending）→ 用户在记忆面板确认（active）→ 注入；
 * ③ 结论层：verdict 摘要（post-execute 回灌，最近窗口）。
 *
 * H-C6-S2 专家日志流水线（同一文档、同一段落纪律）：
 * ④ 运行归档层 runs：agent run 终态自动归档（runId/终态/摘要/工具域），滚动窗口；
 * ⑤ 经验层 lessons：归档日志在预算内提炼的结构化教训（自动注入，域匹配 + 条数预算）。
 *
 * 存储纪律：dataDir 下每项目一份 memories.json，原子写（tmp+rename）、
 * 串行化提交（读改写全程在写链内，防并发整文件覆盖丢条目）、内存缓存、
 * 加载时 fail-closed 形状过滤；旧落盘无 runs/lessons 段按空数组读入
 * （与 provenanceLedger.studyRuns 同一兼容先例）。
 *
 * 注入纪律（硬编码，不做开关）：守则 > 自动记忆 > 提炼经验 > verdict 摘要；
 * 内容只是参考上下文，不是指令，不得覆盖工具白名单与审批要求（注入侧声明+
 * 逐源审计）。未配置（无 RULES.md、无记忆、无 verdict、无 lesson）时零注入、
 * 零文件 IO、零审计源。
 */

export const AGENT_MEMORY_SOURCE_IDS = ["rules-md", "agent-memories", "run-lessons", "prior-verdicts"] as const;
export type AgentMemorySourceId = (typeof AGENT_MEMORY_SOURCE_IDS)[number];

/** 守则注入上限：前 200 行且 25KB（先到者为准），超出部分不进入提示词。 */
export const AGENT_RULES_MAX_LINES = 200;
export const AGENT_RULES_MAX_BYTES = 25 * 1024;
/** 记忆条目容量上限（pending+active+disabled 合计）；超出拒绝新增候选。 */
export const AGENT_MEMORY_MAX_RECORDS = 100;
/** verdict 摘要保留窗口（同 proposalFingerprint 覆盖）。 */
export const AGENT_VERDICT_MAX_RECORDS = 20;
/** 单条记忆/摘要进入提示词的字符上限。 */
export const AGENT_MEMORY_ITEM_MAX_CHARS = 600;

/** H-C6-S2 运行归档滚动窗口（每项目）；超出逐出最旧。 */
export const AGENT_RUN_ARCHIVE_MAX_RECORDS = 50;
/** H-C6-S2 提炼经验滚动窗口（每项目）；超出逐出最旧。 */
export const AGENT_LESSON_MAX_RECORDS = 30;
/** 单轮 decide 注入的提炼经验条数预算（按域匹配过滤后仍受此约束）。 */
export const AGENT_LESSON_INJECTION_MAX_COUNT = 5;
/** 归档目标/摘要的字符上限（证据最小化：归档不是日志原文转储）。 */
export const AGENT_RUN_ARCHIVE_OBJECTIVE_MAX_CHARS = 200;
export const AGENT_RUN_ARCHIVE_SUMMARY_MAX_CHARS = 400;

/** agent run 终态归档：只存指纹级摘要（状态码/理由码/用量），不存决策与输出原文。 */
export interface AgentRunArchive {
  runId: string;
  status: "completed" | "blocked" | "failed" | "cancelled" | "budget-exhausted";
  objective: string;
  /** 结果摘要：完成摘要或失败理由（均已截断），供提炼与人工审计。 */
  outcomeSummary: string;
  failureCode?: string;
  steps: number;
  toolCalls: number;
  /** 任务域键：本轮实际授权工具 ID（提炼经验据此做域匹配）。 */
  toolIds: string[];
  endedAt: string;
}

/** 提炼经验：归档日志→结构化教训，自动注入下轮（区别于需用户确认的偏好层）。 */
export interface AgentLesson {
  id: string;
  /** 提炼规则码（如 failure:tool-failed / guard:variant-circuit），审计与去重用。 */
  code: string;
  content: string;
  runId: string;
  /** 域匹配键：产生教训的工具 ID；空数组=全域经验（任何 run 注入）。 */
  toolIds: string[];
  createdAt: string;
}

export type AgentMemoryStatus = "pending" | "active" | "disabled";

export interface AgentMemoryRecord {
  id: string;
  content: string;
  status: AgentMemoryStatus;
  origin: {
    kind: "agent-proposal";
    runId?: string;
    step?: number;
    proposalFingerprint?: string;
  };
  createdAt: string;
  updatedAt: string;
  confirmedBy?: string;
  confirmedAt?: string;
  /**
   * Semantica 刀2：与本条同主题且结论相悖的既有记录标识（`verdict:<resultFingerprint>` /
   * 记忆条目 id）。只标记不阻断——候选照常登记待确认，冲突对随投递/列表呈现供人工裁决。
   * 判定规则是确定性指纹/理由码比对（见 memoryConflicts.ts），不做向量语义。
   */
  conflictWith?: string[];
}

/** verdict 回灌摘要：只存指纹+判定+理由，不复制假设原文（证据最小化）。 */
export interface AgentVerdictSummary {
  proposalFingerprint: string;
  resultFingerprint: string;
  verdict: "confirmed" | "refuted" | "inconclusive";
  reasonCode: string;
  rationale: string;
  runId?: string;
  step?: number;
  recordedAt: string;
  /** Semantica 刀2：写入时检出的冲突（翻供/理由码反转），同上只标记不阻断。 */
  conflictWith?: string[];
}

export interface AgentMemorySourceDelivery {
  id: AgentMemorySourceId;
  chars: number;
  fingerprint: string;
  truncated: boolean;
}

export interface AgentMemoryDelivery {
  /** false = 未配置任何源：调用方不得注入字段、不得产出审计源（零开销可证伪点）。 */
  configured: boolean;
  rules?: { content: string; truncated: boolean };
  memories: Array<{ id: string; content: string }>;
  lessons: AgentLesson[];
  verdicts: AgentVerdictSummary[];
  /**
   * Semantica 刀2：最近冲突对（UI 呈现用元数据，不进入提示词注入内容，
   * 不计入 injectionChars/sources——提示词组装侧按字段白名单取值）。
   */
  conflicts: AgentMemoryConflictEntry[];
  injectionChars: number;
  sources: AgentMemorySourceDelivery[];
}

interface MemoryDocument {
  schemaVersion: 1;
  memories: AgentMemoryRecord[];
  verdicts: AgentVerdictSummary[];
  /** H-C6-S2：旧落盘无此段按空数组读入（与 provenanceLedger.studyRuns 同先例）。 */
  runs: AgentRunArchive[];
  lessons: AgentLesson[];
  /** Semantica 刀2：冲突登记滚动窗口；旧落盘无此段按空数组读入（同一先例）。 */
  conflicts: AgentMemoryConflictEntry[];
}

export class AgentMemoryLimitError extends Error {
  readonly code = "agent-memory-limit";
  constructor(message: string) {
    super(message);
    this.name = "AgentMemoryLimitError";
  }
}

export class AgentMemoryNotFoundError extends Error {
  readonly code = "agent-memory-not-found";
  constructor(message: string) {
    super(message);
    this.name = "AgentMemoryNotFoundError";
  }
}

export class AgentMemoryStore {
  readonly #root: string;
  readonly #maxRecords: number;
  readonly #maxVerdicts: number;
  readonly #now: () => Date;
  #documents = new Map<string, MemoryDocument>();
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options: { maxMemories?: number; maxVerdicts?: number; now?: () => Date } = {}) {
    this.#root = path.join(dataDir, "agent-memory");
    this.#maxRecords = options.maxMemories ?? AGENT_MEMORY_MAX_RECORDS;
    this.#maxVerdicts = options.maxVerdicts ?? AGENT_VERDICT_MAX_RECORDS;
    this.#now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  /** 人写守则路径：用户/管理员直接编辑该文件，服务端只读。 */
  rulesPath(projectId: string): string {
    return path.join(this.#root, sanitizeProjectId(projectId), "RULES.md");
  }

  /**
   * 组装注入投递：守则 → 生效记忆 → 提炼经验 → verdict 摘要，按预算装入；
   * 优先级硬编码（规则 > 记忆 > 经验 > 摘要），装不下的低优先层截断并标记。
   * 提炼经验按任务域匹配：match.toolIds 给定时，只注入域有交集（或全域）的经验，
   * 且受 AGENT_LESSON_INJECTION_MAX_COUNT 条数预算约束（H-C6-S2）。
   * 每源返回内容指纹，供 decisionProvider 逐源审计。
   */
  async loadDelivery(projectId: string, charBudget = 6_000, match?: { toolIds?: readonly string[] }): Promise<AgentMemoryDelivery> {
    const rules = await this.#loadRules(projectId);
    const document = await this.#loadDocument(projectId);
    const activeMemories = document.memories
      .filter((item) => item.status === "active")
      .sort(byConfirmedAt)
      .map((item) => ({ id: item.id, content: clip(item.content, AGENT_MEMORY_ITEM_MAX_CHARS) }));
    // 域匹配：无 match（chat 侧）或经验无域键=全域；有域键则与当前 run 工具面求交。
    const lessons = document.lessons
      .filter((item) => !match?.toolIds?.length || item.toolIds.length === 0
        || item.toolIds.some((toolId) => match.toolIds!.includes(toolId)))
      .slice(0, AGENT_LESSON_INJECTION_MAX_COUNT)
      .map((item) => ({ ...item, content: clip(item.content, AGENT_MEMORY_ITEM_MAX_CHARS) }));
    const verdicts = document.verdicts.slice(0, 5).map((item) => ({
      ...item,
      rationale: clip(item.rationale, AGENT_MEMORY_ITEM_MAX_CHARS),
    }));

    const delivery: AgentMemoryDelivery = { configured: false, memories: [], lessons: [], verdicts: [], conflicts: [], injectionChars: 0, sources: [] };
    let remaining = Math.max(0, charBudget);
    if (rules) {
      const content = clip(rules.content, remaining);
      const truncated = content.length < rules.content.length || rules.truncated;
      delivery.rules = { content, truncated };
      delivery.sources.push(await sourceDelivery("rules-md", content, truncated));
      remaining -= content.length;
    }
    if (activeMemories.length) {
      const memories: Array<{ id: string; content: string }> = [];
      let truncated = false;
      for (const item of activeMemories) {
        // 预算按注入时的序列化长度计量，保证总注入字符不超过预算。
        const serializedChars = JSON.stringify(item).length;
        if (serializedChars <= remaining) {
          memories.push(item);
          remaining -= serializedChars;
        } else {
          truncated = true;
          break;
        }
      }
      if (memories.length) {
        delivery.memories = memories;
        delivery.sources.push(await sourceDelivery("agent-memories", JSON.stringify(memories), truncated || memories.length < activeMemories.length));
      }
    }
    if (lessons.length) {
      const allowedLessons: AgentLesson[] = [];
      let truncated = false;
      for (const item of lessons) {
        const serializedChars = JSON.stringify(item).length;
        if (serializedChars <= Math.max(0, remaining)) {
          allowedLessons.push(item);
          remaining -= serializedChars;
        } else {
          truncated = true;
          break;
        }
      }
      if (allowedLessons.length) {
        delivery.lessons = allowedLessons;
        delivery.sources.push(await sourceDelivery("run-lessons", JSON.stringify(allowedLessons), truncated || allowedLessons.length < lessons.length));
      }
    }
    if (verdicts.length) {
      const allowed = Math.max(0, remaining);
      const serialized = JSON.stringify(verdicts.map(({ proposalFingerprint, resultFingerprint, verdict, reasonCode, rationale, recordedAt }) => ({
        proposalFingerprint, resultFingerprint, verdict, reasonCode, rationale, recordedAt,
      })));
      if (serialized.length <= allowed) {
        delivery.verdicts = verdicts;
        delivery.sources.push(await sourceDelivery("prior-verdicts", serialized, false));
      } else {
        // 预算不够整块装下时从最旧开始丢，保最近结论（上一轮的 refuted 最有价值）。
        const kept: AgentVerdictSummary[] = [];
        for (const item of verdicts) {
          const candidate = JSON.stringify([...kept, item].map(pickVerdictFields));
          if (candidate.length > allowed) break;
          kept.push(item);
        }
        if (kept.length) {
          delivery.verdicts = kept;
          delivery.sources.push(await sourceDelivery("prior-verdicts", JSON.stringify(kept.map(pickVerdictFields)), true));
        }
      }
    }
    delivery.configured = delivery.sources.length > 0;
    delivery.injectionChars = delivery.sources.reduce((total, item) => total + item.chars, 0);
    // Semantica 刀2：冲突对随投递一并返回供 UI 呈现（呈现用元数据，不注入提示词、不计预算）。
    delivery.conflicts = structuredClone(draftConflicts(document)).slice(0, AGENT_MEMORY_CONFLICT_DELIVERY_MAX);
    return delivery;
  }

  /** 冲突登记清单（记忆面板用）：最近优先的滚动窗口。 */
  async listConflicts(projectId: string): Promise<AgentMemoryConflictEntry[]> {
    return structuredClone(draftConflicts(await this.#loadDocument(projectId)));
  }

  async listMemories(projectId: string): Promise<AgentMemoryRecord[]> {
    return structuredClone((await this.#loadDocument(projectId)).memories);
  }

  async rulesSummary(projectId: string): Promise<{ configured: boolean; chars: number; truncated: boolean; fingerprint?: string; excerpt?: string }> {
    const rules = await this.#loadRules(projectId);
    if (!rules) return { configured: false, chars: 0, truncated: false };
    const fingerprint = await contentFingerprint(rules.content);
    return {
      configured: true,
      chars: rules.content.length,
      truncated: rules.truncated,
      fingerprint,
      excerpt: clip(rules.content, 1_200),
    };
  }

  /** agent 提炼候选：一律 pending，等待用户在记忆面板确认；容量满抛 AgentMemoryLimitError。 */
  async addMemoryCandidate(projectId: string, input: { content: string; runId?: string; step?: number; proposalFingerprint?: string }): Promise<AgentMemoryRecord> {
    const content = requireContent(input.content);
    const now = this.#now().toISOString();
    return this.#commit(projectId, (draft) => {
      // 容量闸在写链内判定：并发候选以已提交最新计数为准，超出 fail-closed 拒绝。
      // 链外判定会数不到并发中的新增（闸失效）且整文件覆盖互相丢候选。
      if (draft.memories.length >= this.#maxRecords) {
        throw new AgentMemoryLimitError(`项目记忆已达上限 ${this.#maxRecords} 条；请在记忆面板清理后再试`);
      }
      // Semantica 刀2：冲突检测同样在写链内（对已提交最新 active 记忆与判定窗口比对），
      // 标记冲突不阻断——候选照常登记，conflictWith 与冲突登记同步落盘。
      const pairs = detectMemoryCandidateConflicts(
        extractMemoryTopics({ originProposalFingerprint: input.proposalFingerprint ?? undefined, content }),
        draft.memories.filter((item) => item.status === "active"),
        draft.verdicts,
      );
      const record: AgentMemoryRecord = {
        id: createMemoryId(),
        content,
        status: "pending",
        origin: {
          kind: "agent-proposal",
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.step !== undefined ? { step: input.step } : {}),
          ...(input.proposalFingerprint ? { proposalFingerprint: input.proposalFingerprint } : {}),
        },
        createdAt: now,
        updatedAt: now,
        ...(pairs.length ? { conflictWith: pairs.map((pair) => pair.withRecordId) } : {}),
      };
      draft.memories.push(record);
      pushConflictEntries(draft, record.id, pairs, now);
      return record;
    });
  }

  /** 用户确认：pending → active。 */
  async confirmMemory(projectId: string, memoryId: string, confirmedBy: string): Promise<AgentMemoryRecord> {
    return this.#mutateMemory(projectId, memoryId, (record) => {
      if (record.status === "active") return record;
      record.status = "active";
      record.confirmedBy = requireContent(confirmedBy, "确认人");
      record.confirmedAt = this.#now().toISOString();
      record.updatedAt = record.confirmedAt;
    });
  }

  /** 启停或编辑：active ↔ disabled；内容更新必须非空。 */
  async updateMemory(projectId: string, memoryId: string, patch: { content?: string; enabled?: boolean }): Promise<AgentMemoryRecord> {
    return this.#mutateMemory(projectId, memoryId, (record) => {
      if (patch.content !== undefined) record.content = requireContent(patch.content);
      if (patch.enabled !== undefined) {
        if (patch.enabled) {
          if (record.status === "pending") throw new AgentMemoryLimitError("候选记忆必须先经用户确认才能生效");
          record.status = "active";
          record.confirmedAt ??= this.#now().toISOString();
        } else if (record.status === "active") {
          record.status = "disabled";
        }
      }
      record.updatedAt = this.#now().toISOString();
    });
  }

  async deleteMemory(projectId: string, memoryId: string): Promise<void> {
    await this.#commit(projectId, (draft) => {
      // 存在性判定在写链内：并发删除/确认交错时以已提交最新文档为准，不误删不误报。
      if (!draft.memories.some((item) => item.id === memoryId)) {
        throw new AgentMemoryNotFoundError(`记忆条目不存在：${memoryId}`);
      }
      draft.memories = draft.memories.filter((item) => item.id !== memoryId);
    });
  }

  /** verdict 回灌：最近窗口内同 proposalFingerprint 覆盖，refuted 结论下轮不得重复提案。 */
  async recordVerdict(projectId: string, summary: Omit<AgentVerdictSummary, "recordedAt">): Promise<AgentVerdictSummary> {
    if (!/^[0-9a-f]{16}$/.test(summary.proposalFingerprint) || !/^[0-9a-f]{16}$/.test(summary.resultFingerprint)) {
      throw new AgentMemoryLimitError("verdict 摘要指纹必须是 16 位十六进制");
    }
    const base: AgentVerdictSummary = { ...summary, rationale: clip(requireContent(summary.rationale, "rationale"), AGENT_MEMORY_ITEM_MAX_CHARS), recordedAt: this.#now().toISOString() };
    return this.#commit(projectId, (draft) => {
      // Semantica 刀2：翻供/理由码反转检测在覆盖写入前、写链内进行（看到已提交最新窗口）；
      // 旧判定将被窗口覆盖，冲突对落 conflicts 登记留痕，新判定挂 conflictWith 只标记不阻断。
      const pairs = detectVerdictConflicts(base, draft.verdicts);
      const record: AgentVerdictSummary = { ...base, ...(pairs.length ? { conflictWith: pairs.map((pair) => pair.withRecordId) } : {}) };
      draft.verdicts = [record, ...draft.verdicts.filter((item) => item.proposalFingerprint !== record.proposalFingerprint)].slice(0, this.#maxVerdicts);
      pushConflictEntries(draft, `verdict:${record.resultFingerprint}`, pairs, record.recordedAt);
      return record;
    });
  }

  async listVerdicts(projectId: string): Promise<AgentVerdictSummary[]> {
    return structuredClone((await this.#loadDocument(projectId)).verdicts);
  }

  /**
   * H-C6-S2 运行归档：run 终态自动落档；同 runId 重收口（重试/恢复场景）覆盖更新。
   * 滚动窗口超出逐出最旧，fail-closed 拒绝非法输入。
   */
  async archiveRun(projectId: string, input: Omit<AgentRunArchive, "objective" | "outcomeSummary"> & { objective: string; outcomeSummary: string }): Promise<{ archive: AgentRunArchive; duplicate: boolean }> {
    const archive: AgentRunArchive = {
      ...input,
      objective: requireContent(input.objective, "目标").slice(0, AGENT_RUN_ARCHIVE_OBJECTIVE_MAX_CHARS),
      outcomeSummary: requireContent(input.outcomeSummary, "结果摘要").slice(0, AGENT_RUN_ARCHIVE_SUMMARY_MAX_CHARS),
    };
    let duplicate = false;
    await this.#commit(projectId, (draft) => {
      const existingIndex = draft.runs.findIndex((item) => item.runId === archive.runId);
      duplicate = existingIndex >= 0;
      if (duplicate) draft.runs.splice(existingIndex, 1);
      draft.runs.unshift(archive);
      if (draft.runs.length > AGENT_RUN_ARCHIVE_MAX_RECORDS) {
        draft.runs.length = AGENT_RUN_ARCHIVE_MAX_RECORDS;
      }
    });
    return { archive: structuredClone(archive), duplicate };
  }

  async listRunArchives(projectId: string): Promise<AgentRunArchive[]> {
    return structuredClone((await this.#loadDocument(projectId)).runs);
  }

  /**
   * H-C6-S2 提炼经验落档：先清同 runId 旧经验（重收口幂等），再按滚动窗口保存。
   * 全量替换（不是追加）由调用方保证条数上限内——提炼预算的执行点在提炼侧。
   */
  async replaceLessons(projectId: string, runId: string, lessons: Array<Omit<AgentLesson, "id" | "createdAt" | "runId">>): Promise<AgentLesson[]> {
    requireContent(runId, "runId");
    const stamped: AgentLesson[] = lessons.map((item) => ({
      ...item,
      code: requireContent(item.code, "code"),
      content: clip(requireContent(item.content), AGENT_MEMORY_ITEM_MAX_CHARS),
      toolIds: item.toolIds.filter((toolId) => typeof toolId === "string" && toolId.trim()).slice(0, 20),
      id: createMemoryId(),
      runId,
      createdAt: this.#now().toISOString(),
    }));
    await this.#commit(projectId, (draft) => {
      draft.lessons = [...stamped, ...draft.lessons.filter((item) => item.runId !== runId)].slice(0, AGENT_LESSON_MAX_RECORDS);
    });
    return structuredClone(stamped);
  }

  async listLessons(projectId: string): Promise<AgentLesson[]> {
    return structuredClone((await this.#loadDocument(projectId)).lessons);
  }

  async #mutateMemory(projectId: string, memoryId: string, mutate: (record: AgentMemoryRecord) => void): Promise<AgentMemoryRecord> {
    return this.#commit(projectId, (draft) => {
      const target = draft.memories.find((item) => item.id === memoryId);
      if (!target) throw new AgentMemoryNotFoundError(`记忆条目不存在：${memoryId}`);
      mutate(target);
      return structuredClone(target);
    });
  }

  /**
   * 串行化提交：读档→clone→mutate→persist 全程在写链内执行（真串行读改写）。
   * 容量闸、确认/启停/删除、verdict 覆盖窗口都依赖"检查时看到的是已提交最新值"——
   * 若在链外读档/clone（先读后排队写），并发提交各自基于陈旧文档整文件覆盖
   * （lost update），容量闸也永远数不到并发中的新增。与 simulationStudyTasks/
   * provenanceLedger 同一纪律。失败时缓存不切换（persist 成功才换），读侧永不
   * 暴露未落盘状态——链外形态时代的 rollback 补丁由此作废。
   */
  async #commit<T>(projectId: string, mutate: (draft: MemoryDocument) => T): Promise<T> {
    const operation = this.#writes.then(async () => {
      const document = await this.#loadDocument(projectId);
      const draft: MemoryDocument = structuredClone(document);
      const result = mutate(draft);
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
      return result;
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #loadDocument(projectId: string): Promise<MemoryDocument> {
    const cached = this.#documents.get(projectId);
    if (cached) return cached;
    const filePath = this.#documentPath(projectId);
    let document: MemoryDocument = { schemaVersion: 1, memories: [], verdicts: [], runs: [], lessons: [], conflicts: [] };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MemoryDocument>;
      if (parsed.schemaVersion === 1) {
        document = {
          schemaVersion: 1,
          memories: Array.isArray(parsed.memories) ? parsed.memories.filter(isMemoryRecord) : [],
          verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts.filter(isVerdictSummary).slice(0, this.#maxVerdicts) : [],
          // H-C6-S2：旧落盘无 runs/lessons 段按空数组读入；坏行丢弃不回退。
          runs: Array.isArray(parsed.runs) ? parsed.runs.filter(isRunArchive).slice(0, AGENT_RUN_ARCHIVE_MAX_RECORDS) : [],
          lessons: Array.isArray(parsed.lessons) ? parsed.lessons.filter(isLesson).slice(0, AGENT_LESSON_MAX_RECORDS) : [],
          // Semantica 刀2：旧落盘无 conflicts 段按空数组读入（同一兼容先例）。
          conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.filter(isMemoryConflictEntry).slice(0, AGENT_MEMORY_CONFLICT_MAX_RECORDS) : [],
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#documents.set(projectId, document);
    return document;
  }

  async #persist(projectId: string, document: MemoryDocument): Promise<void> {
    const filePath = this.#documentPath(projectId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #loadRules(projectId: string): Promise<{ content: string; truncated: boolean } | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.rulesPath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const trimmed = raw.replace(/\r\n/g, "\n").trim();
    if (!trimmed) return undefined;
    const lines = trimmed.split("\n");
    let content = lines.slice(0, AGENT_RULES_MAX_LINES).join("\n");
    const bytes = Buffer.byteLength(content, "utf8");
    let truncated = lines.length > AGENT_RULES_MAX_LINES;
    if (bytes > AGENT_RULES_MAX_BYTES) {
      content = clipByBytes(content, AGENT_RULES_MAX_BYTES);
      truncated = true;
    }
    return { content, truncated };
  }

  #documentPath(projectId: string): string {
    return path.join(this.#root, sanitizeProjectId(projectId), "memories.json");
  }
}

function byConfirmedAt(left: AgentMemoryRecord, right: AgentMemoryRecord): number {
  return (left.confirmedAt ?? left.createdAt).localeCompare(right.confirmedAt ?? right.createdAt);
}

function draftConflicts(document: MemoryDocument): AgentMemoryConflictEntry[] {
  return Array.isArray(document.conflicts) ? document.conflicts : [];
}

/** 冲突登记入档：滚动窗口（最近优先），不阻断写路径本身。 */
function pushConflictEntries(draft: MemoryDocument, recordId: string, pairs: MemoryConflictPair[], detectedAt: string): void {
  if (!pairs.length) return;
  const entries: AgentMemoryConflictEntry[] = pairs.map((pair, index) => ({
    id: `${recordId}:conflict:${index}`,
    kind: pair.kind,
    topic: pair.topic,
    recordId,
    conflictWith: [pair.withRecordId],
    detectedAt,
  }));
  draft.conflicts = [...entries, ...draftConflicts(draft)].slice(0, AGENT_MEMORY_CONFLICT_MAX_RECORDS);
}

function pickVerdictFields(item: AgentVerdictSummary) {
  return {
    proposalFingerprint: item.proposalFingerprint,
    resultFingerprint: item.resultFingerprint,
    verdict: item.verdict,
    reasonCode: item.reasonCode,
    rationale: item.rationale,
    recordedAt: item.recordedAt,
  };
}

async function sourceDelivery(id: AgentMemorySourceId, content: string, truncated: boolean): Promise<AgentMemorySourceDelivery> {
  return { id, chars: content.length, fingerprint: await contentFingerprint(content), truncated };
}

async function contentFingerprint(content: string): Promise<string> {
  return fingerprint64Labeled([["agent-memory-source", content]]);
}

function requireContent(value: string, label = "内容"): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AgentMemoryLimitError(`${label}不能为空`);
  return text.slice(0, 4_000);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[已截断]` : value;
}

function clipByBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  // 末尾多字节字符被切时会变成替换符，清掉后保证不超过预算。
  const sliced = buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${sliced}\n…[已按 25KB 截断]`;
}

function sanitizeProjectId(projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(projectId) || projectId.includes("..")) {
    throw new AgentMemoryLimitError("项目标识不合法，无法定位记忆目录");
  }
  return projectId;
}

function isMemoryRecord(value: unknown): value is AgentMemoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentMemoryRecord>;
  return typeof record.id === "string"
    && typeof record.content === "string"
    && (record.status === "pending" || record.status === "active" || record.status === "disabled")
    && typeof record.createdAt === "string";
}

function isVerdictSummary(value: unknown): value is AgentVerdictSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentVerdictSummary>;
  return typeof record.proposalFingerprint === "string"
    && typeof record.resultFingerprint === "string"
    && typeof record.reasonCode === "string"
    && typeof record.rationale === "string"
    && record.verdict !== undefined;
}

const RUN_ARCHIVE_STATUSES = ["completed", "blocked", "failed", "cancelled", "budget-exhausted"] as const;

function isRunArchive(value: unknown): value is AgentRunArchive {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentRunArchive>;
  return typeof record.runId === "string"
    && typeof record.status === "string" && (RUN_ARCHIVE_STATUSES as readonly string[]).includes(record.status)
    && typeof record.objective === "string"
    && typeof record.outcomeSummary === "string"
    && typeof record.steps === "number"
    && typeof record.toolCalls === "number"
    && Array.isArray(record.toolIds) && record.toolIds.every((item) => typeof item === "string")
    && typeof record.endedAt === "string";
}

function isLesson(value: unknown): value is AgentLesson {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentLesson>;
  return typeof record.id === "string"
    && typeof record.code === "string"
    && typeof record.content === "string"
    && typeof record.runId === "string"
    && Array.isArray(record.toolIds) && record.toolIds.every((item) => typeof item === "string")
    && typeof record.createdAt === "string";
}

function createMemoryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
