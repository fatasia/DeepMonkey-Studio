import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assembleAiProvenanceTrace,
  buildAiProvenanceHypothesisNode,
  buildAiProvenanceKernelRunNode,
  buildAiProvenanceVerdictNode,
  validateAiProvenanceQuery,
  type AiProvenanceChain,
  type AiProvenanceChainSummary,
  type AiProvenanceHypothesisNode,
  type AiProvenanceKernelRunNode,
  type AiProvenanceQuery,
  type AiProvenanceReportNode,
  type AiProvenanceTrace,
  type AiProvenanceVerdictNode,
  type AiVerificationEnvelope,
  type AiHypothesisContract,
} from "@bim-studio/contracts";

/**
 * H-C3 档案室：ProvenanceLedger（节点=假设/内核运行/判定/报告，边=proposal→run→verdict→report）。
 *
 * 存储复用 agentMemory.ts 的文档元数据模式：dataDir 下每项目一份 JSON，
 * 原子写（tmp+rename）、串行化提交、内存缓存、加载时 fail-closed 形状过滤。
 * 证据最小化：只存指纹+判定+理由码+摘要，不存提示词原文与用户数据。
 *
 * 指纹不变量（可证伪点）：同一 inputFingerprint 的确定性重跑产生同一 resultFingerprint，
 * 账本按 nodeId 幂等 upsert —— 长跑断线恢复后链指纹不变。账本故障不阻断验证主链路，
 * 但以 warning 如实上浮（不静默丢档案）。
 */

/** 每项目链（假设节点）容量上限；超出按登记时间逐出最旧链及其孤立运行。 */
export const PROVENANCE_MAX_CHAINS = 200;
/** 每项目报告节点容量上限。 */
export const PROVENANCE_MAX_REPORTS = 200;

export class ProvenanceLedgerError extends Error {
  readonly code = "provenance-ledger";
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceLedgerError";
  }
}

interface ProvenanceDocument {
  schemaVersion: 1;
  hypotheses: AiProvenanceHypothesisNode[];
  runs: AiProvenanceKernelRunNode[];
  verdicts: AiProvenanceVerdictNode[];
  reports: AiProvenanceReportNode[];
}

/** 档案列表条目类型 AiProvenanceChainSummary 定义在 contracts（跨端合同），此处仅消费。 */

export class ProvenanceLedgerStore {
  readonly #root: string;
  readonly #maxChains: number;
  readonly #maxReports: number;
  readonly #now: () => Date;
  #documents = new Map<string, ProvenanceDocument>();
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options: { maxChains?: number; maxReports?: number; now?: () => Date } = {}) {
    this.#root = path.join(dataDir, "provenance-ledger");
    this.#maxChains = options.maxChains ?? PROVENANCE_MAX_CHAINS;
    this.#maxReports = options.maxReports ?? PROVENANCE_MAX_REPORTS;
    this.#now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  /** 登记假设（simulation.hypothesis.register 落账）：只登记不验证的链保持"未运行"状态。 */
  async recordHypothesis(projectId: string, input: { contract: AiHypothesisContract; proposalFingerprint: string }): Promise<AiProvenanceHypothesisNode> {
    const node = buildAiProvenanceHypothesisNode(input.contract, input.proposalFingerprint, this.#now().toISOString());
    await this.#commit(projectId, (draft) => {
      const existing = draft.hypotheses.find((item) => item.proposalFingerprint === node.proposalFingerprint);
      if (existing) {
        // 同指纹重提：保持原登记时点与已验证状态，链语义是"同一假设"而非新版本。
        return existing;
      }
      draft.hypotheses.push(node);
      this.#evictOldestChains(draft);
      return node;
    });
    return node;
  }

  /** golden 验证落账（simulation.golden.verify 产出信封处）：假设+运行+判定同事务成链。 */
  async recordVerification(
    projectId: string,
    input: { envelope: AiVerificationEnvelope; contract: AiHypothesisContract; seed?: string; replications?: number },
  ): Promise<{ hypothesis: AiProvenanceHypothesisNode; run: AiProvenanceKernelRunNode; verdict: AiProvenanceVerdictNode }> {
    const { envelope, contract } = input;
    const executedAt = this.#now().toISOString();
    const run = buildAiProvenanceKernelRunNode(envelope, {
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.replications !== undefined ? { replications: input.replications } : {}),
      executedAt,
    });
    const verdict = buildAiProvenanceVerdictNode(envelope, executedAt);
    let hypothesis!: AiProvenanceHypothesisNode;
    await this.#commit(projectId, (draft) => {
      // 假设节点可能未经 register 直达 verify（MCP 直调路径）：缺则补登，登记时点取首次验证时间。
      const existing = draft.hypotheses.find((item) => item.proposalFingerprint === envelope.proposalFingerprint);
      hypothesis = existing ?? buildAiProvenanceHypothesisNode(contract, envelope.proposalFingerprint, executedAt);
      if (!existing) draft.hypotheses.push(hypothesis);
      else if (!existing.verifiedAt) draft.hypotheses[draft.hypotheses.indexOf(existing)] = { ...existing, verifiedAt: executedAt };
      // 同 resultFingerprint 幂等 upsert：确定性重跑同指纹，只刷新运行/判定时点。
      upsertById(draft.runs, run);
      upsertById(draft.verdicts, verdict);
      this.#evictOldestChains(draft);
      return { hypothesis, run, verdict };
    });
    return { hypothesis, run, verdict };
  }

  /** 报告节点落账（Study 证据指纹）。第一切片提供 API，生产者接线在后续切片（报告中如实声明）。 */
  async recordReport(
    projectId: string,
    input: { evidenceFingerprint: string; label: string; proposalFingerprint?: string; resultFingerprint?: string },
  ): Promise<AiProvenanceReportNode> {
    const evidenceFingerprint = requireFingerprint(input.evidenceFingerprint, "evidenceFingerprint");
    const label = input.label.trim();
    if (!label) throw new ProvenanceLedgerError("报告标签不能为空");
    const node: AiProvenanceReportNode = {
      kind: "report",
      nodeId: `report:${evidenceFingerprint}`,
      ...(input.proposalFingerprint ? { proposalFingerprint: requireFingerprint(input.proposalFingerprint, "proposalFingerprint") } : {}),
      ...(input.resultFingerprint ? { resultFingerprint: requireFingerprint(input.resultFingerprint, "resultFingerprint") } : {}),
      evidenceFingerprint,
      label: label.slice(0, 400),
      reportedAt: this.#now().toISOString(),
    };
    await this.#commit(projectId, (draft) => {
      upsertById(draft.reports, node);
      if (draft.reports.length > this.#maxReports) {
        draft.reports.sort((left, right) => left.reportedAt.localeCompare(right.reportedAt));
        draft.reports = draft.reports.slice(-this.#maxReports);
      }
      return node;
    });
    return node;
  }

  /** 三跳查询：指纹/时间任一维度；结果含全库完整性核查，未命中如实 matched=false。 */
  async trace(projectId: string, query: AiProvenanceQuery): Promise<AiProvenanceTrace> {
    const normalized = validateAiProvenanceQuery(query);
    const document = await this.#loadDocument(projectId);
    return assembleAiProvenanceTrace(
      {
        hypotheses: structuredClone(document.hypotheses),
        runs: structuredClone(document.runs),
        verdicts: structuredClone(document.verdicts),
        reports: structuredClone(document.reports),
      },
      normalized,
    );
  }

  /** 档案列表（工作区入口）：按最近活动排序的链摘要。 */
  async listChains(projectId: string, limit = 20): Promise<{ chains: AiProvenanceChainSummary[]; integrity: { intact: boolean; brokenNodes: string[] } }> {
    const trace = await this.trace(projectId, { limit: 100 });
    const broken = new Set(trace.integrity.brokenNodes);
    const chains = trace.chains
      .map(toSummary)
      .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
    return { chains, integrity: trace.integrity };
  }

  /** 供断链定位：按结果指纹精确取链（卡片"查看档案"的主路径）。 */
  async chainByResult(projectId: string, resultFingerprint: string): Promise<AiProvenanceChain | undefined> {
    const trace = await this.trace(projectId, { resultFingerprint, limit: 1 });
    return trace.chains[0];
  }

  #evictOldestChains(draft: ProvenanceDocument): void {
    if (draft.hypotheses.length <= this.#maxChains) return;
    draft.hypotheses.sort((left, right) => left.registeredAt.localeCompare(right.registeredAt));
    const evicted = new Set(draft.hypotheses.slice(0, draft.hypotheses.length - this.#maxChains).map((node) => node.proposalFingerprint));
    draft.hypotheses = draft.hypotheses.slice(-this.#maxChains);
    if (evicted.size) {
      draft.runs = draft.runs.filter((node) => !evicted.has(node.proposalFingerprint));
      draft.verdicts = draft.verdicts.filter((node) => !evicted.has(node.proposalFingerprint));
    }
  }

  async #commit<T>(projectId: string, mutate: (draft: ProvenanceDocument) => T): Promise<T> {
    const document = await this.#loadDocument(projectId);
    const draft: ProvenanceDocument = structuredClone(document);
    const result = mutate(draft);
    const operation = this.#writes.then(async () => {
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  async #loadDocument(projectId: string): Promise<ProvenanceDocument> {
    const cached = this.#documents.get(projectId);
    if (cached) return cached;
    const filePath = this.#documentPath(projectId);
    let document: ProvenanceDocument = { schemaVersion: 1, hypotheses: [], runs: [], verdicts: [], reports: [] };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ProvenanceDocument>;
      if (parsed.schemaVersion === 1) {
        document = {
          schemaVersion: 1,
          hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses.filter(isHypothesisNode) : [],
          runs: Array.isArray(parsed.runs) ? parsed.runs.filter(isRunNode) : [],
          verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts.filter(isVerdictNode) : [],
          reports: Array.isArray(parsed.reports) ? parsed.reports.filter(isReportNode) : [],
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#documents.set(projectId, document);
    return document;
  }

  async #persist(projectId: string, document: ProvenanceDocument): Promise<void> {
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

  #documentPath(projectId: string): string {
    return path.join(this.#root, sanitizeProjectId(projectId), "ledger.json");
  }
}

function toSummary(chain: AiProvenanceChain): AiProvenanceChainSummary {
  const latest = chain.verdicts
    .slice()
    .sort((left, right) => right.judgedAt.localeCompare(left.judgedAt))
    .at(0);
  return {
    hypothesis: chain.hypothesis,
    runCount: chain.runs.length,
    reportCount: chain.reports.length,
    ...(latest ? { latest: { verdict: latest.verdict, reasonCode: latest.reasonCode, judgedAt: latest.judgedAt } } : {}),
    integrity: chain.integrity,
    lastActivityAt: chainStamp(chain),
  };
}

function chainStamp(chain: AiProvenanceChain): string {
  return [
    chain.hypothesis.registeredAt,
    ...chain.runs.map((node) => node.executedAt),
    ...chain.verdicts.map((node) => node.judgedAt),
    ...chain.reports.map((node) => node.reportedAt),
  ].sort().at(-1) ?? chain.hypothesis.registeredAt;
}

function upsertById<T extends { nodeId: string }>(items: T[], node: T): void {
  const index = items.findIndex((item) => item.nodeId === node.nodeId);
  if (index >= 0) items[index] = node;
  else items.push(node);
}

function requireFingerprint(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value)) {
    throw new ProvenanceLedgerError(`${field} 必须是 16 位小写十六进制指纹`);
  }
  return value;
}

function sanitizeProjectId(projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(projectId) || projectId.includes("..")) {
    throw new ProvenanceLedgerError("项目标识不合法，无法定位档案目录");
  }
  return projectId;
}

function isHypothesisNode(value: unknown): value is AiProvenanceHypothesisNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<AiProvenanceHypothesisNode>;
  return node.kind === "hypothesis"
    && typeof node.nodeId === "string"
    && typeof node.proposalFingerprint === "string"
    && typeof node.hypothesisId === "string"
    && typeof node.registeredAt === "string";
}

function isRunNode(value: unknown): value is AiProvenanceKernelRunNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<AiProvenanceKernelRunNode>;
  return node.kind === "kernel-run"
    && typeof node.nodeId === "string"
    && typeof node.proposalFingerprint === "string"
    && typeof node.inputFingerprint === "string"
    && typeof node.resultFingerprint === "string"
    && typeof node.executedAt === "string";
}

function isVerdictNode(value: unknown): value is AiProvenanceVerdictNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<AiProvenanceVerdictNode>;
  return node.kind === "verdict"
    && typeof node.nodeId === "string"
    && typeof node.proposalFingerprint === "string"
    && typeof node.resultFingerprint === "string"
    && typeof node.verdict === "string"
    && typeof node.reasonCode === "string"
    && typeof node.integrityFingerprint === "string"
    && typeof node.judgedAt === "string";
}

function isReportNode(value: unknown): value is AiProvenanceReportNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<AiProvenanceReportNode>;
  return node.kind === "report"
    && typeof node.nodeId === "string"
    && typeof node.evidenceFingerprint === "string"
    && typeof node.reportedAt === "string";
}
