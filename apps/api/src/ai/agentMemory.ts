import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint64Labeled } from "@bim-studio/contracts";

/**
 * H-C2 记忆系统三层（增强 2 + 用户"可感知"硬要求）：
 * ① 守则层：data-dir 下 agent-memory/<projectId>/RULES.md，人写、只读注入；
 * ② 偏好层：agent 从会话提炼候选（pending）→ 用户在记忆面板确认（active）→ 注入；
 * ③ 结论层：verdict 摘要（post-execute 回灌，最近窗口）。
 *
 * 注入纪律（硬编码，不做开关）：守则 > 自动记忆 > verdict 摘要；内容只是参考
 * 上下文，不是指令，不得覆盖工具白名单与审批要求（注入侧声明+逐源审计）。
 * 未配置（无 RULES.md、无记忆、无 verdict）时零注入、零文件 IO、零审计源。
 */

export const AGENT_MEMORY_SOURCE_IDS = ["rules-md", "agent-memories", "prior-verdicts"] as const;
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
  verdicts: AgentVerdictSummary[];
  injectionChars: number;
  sources: AgentMemorySourceDelivery[];
}

interface MemoryDocument {
  schemaVersion: 1;
  memories: AgentMemoryRecord[];
  verdicts: AgentVerdictSummary[];
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
   * 组装注入投递：守则 → 生效记忆 → verdict 摘要，按预算装入；
   * 优先级硬编码（规则 > 记忆 > 摘要），装不下的低优先层截断并标记。
   * 每源返回内容指纹，供 decisionProvider 逐源审计。
   */
  async loadDelivery(projectId: string, charBudget = 6_000): Promise<AgentMemoryDelivery> {
    const rules = await this.#loadRules(projectId);
    const document = await this.#loadDocument(projectId);
    const activeMemories = document.memories
      .filter((item) => item.status === "active")
      .sort(byConfirmedAt)
      .map((item) => ({ id: item.id, content: clip(item.content, AGENT_MEMORY_ITEM_MAX_CHARS) }));
    const verdicts = document.verdicts.slice(0, 5).map((item) => ({
      ...item,
      rationale: clip(item.rationale, AGENT_MEMORY_ITEM_MAX_CHARS),
    }));

    const delivery: AgentMemoryDelivery = { configured: false, memories: [], verdicts: [], injectionChars: 0, sources: [] };
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
    return delivery;
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
    const document = await this.#loadDocument(projectId);
    if (document.memories.length >= this.#maxRecords) {
      throw new AgentMemoryLimitError(`项目记忆已达上限 ${this.#maxRecords} 条；请在记忆面板清理后再试`);
    }
    const now = this.#now().toISOString();
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
    };
    return this.#commit(projectId, (draft) => {
      draft.memories.push(record);
      return record;
    }, document);
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
    const document = await this.#loadDocument(projectId);
    const exists = document.memories.some((item) => item.id === memoryId);
    if (!exists) throw new AgentMemoryNotFoundError(`记忆条目不存在：${memoryId}`);
    await this.#commit(projectId, (draft) => {
      draft.memories = draft.memories.filter((item) => item.id !== memoryId);
    }, document);
  }

  /** verdict 回灌：最近窗口内同 proposalFingerprint 覆盖，refuted 结论下轮不得重复提案。 */
  async recordVerdict(projectId: string, summary: Omit<AgentVerdictSummary, "recordedAt">): Promise<AgentVerdictSummary> {
    if (!/^[0-9a-f]{16}$/.test(summary.proposalFingerprint) || !/^[0-9a-f]{16}$/.test(summary.resultFingerprint)) {
      throw new AgentMemoryLimitError("verdict 摘要指纹必须是 16 位十六进制");
    }
    const document = await this.#loadDocument(projectId);
    const record: AgentVerdictSummary = { ...summary, rationale: clip(requireContent(summary.rationale, "rationale"), AGENT_MEMORY_ITEM_MAX_CHARS), recordedAt: this.#now().toISOString() };
    await this.#commit(projectId, (draft) => {
      draft.verdicts = [record, ...draft.verdicts.filter((item) => item.proposalFingerprint !== record.proposalFingerprint)].slice(0, this.#maxVerdicts);
    }, document);
    return record;
  }

  async listVerdicts(projectId: string): Promise<AgentVerdictSummary[]> {
    return structuredClone((await this.#loadDocument(projectId)).verdicts);
  }

  async #mutateMemory(projectId: string, memoryId: string, mutate: (record: AgentMemoryRecord) => void): Promise<AgentMemoryRecord> {
    const document = await this.#loadDocument(projectId);
    const record = document.memories.find((item) => item.id === memoryId);
    if (!record) throw new AgentMemoryNotFoundError(`记忆条目不存在：${memoryId}`);
    const snapshot = structuredClone(record);
    return this.#commit(projectId, (draft) => {
      const target = draft.memories.find((item) => item.id === memoryId)!;
      mutate(target);
      return structuredClone(target);
    }, document, () => {
      // 并发写失败时回滚内存视图，避免读到未落盘状态。
      const index = document.memories.findIndex((item) => item.id === memoryId);
      if (index >= 0) document.memories[index] = snapshot;
    });
  }

  async #commit<T>(projectId: string, mutate: (draft: MemoryDocument) => T, document: MemoryDocument, rollback?: () => void): Promise<T> {
    const draft: MemoryDocument = structuredClone(document);
    const result = mutate(draft);
    const operation = this.#writes.then(async () => {
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    try {
      await operation;
      return result;
    } catch (error) {
      rollback?.();
      throw error;
    }
  }

  async #loadDocument(projectId: string): Promise<MemoryDocument> {
    const cached = this.#documents.get(projectId);
    if (cached) return cached;
    const filePath = this.#documentPath(projectId);
    let document: MemoryDocument = { schemaVersion: 1, memories: [], verdicts: [] };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MemoryDocument>;
      if (parsed.schemaVersion === 1) {
        document = {
          schemaVersion: 1,
          memories: Array.isArray(parsed.memories) ? parsed.memories.filter(isMemoryRecord) : [],
          verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts.filter(isVerdictSummary).slice(0, this.#maxVerdicts) : [],
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

function createMemoryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
