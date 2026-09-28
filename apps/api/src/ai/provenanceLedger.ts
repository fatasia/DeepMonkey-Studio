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
 * 原子写（tmp+rename）、串行化提交（读改写全程在写链内，防并发整文件覆盖丢节点）、
 * 内存缓存、加载时 fail-closed 形状过滤。
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
  /** 异步长跑的进行中/已收口记录（H-C3 后续切片增量）；旧落盘无此段时按空数组读入。 */
  studyRuns: AiProvenanceStudyRunRecord[];
}

/**
 * 异步长跑（simulation.study.run-async）在账本中的运行段记录：app 侧扩展，不入合同三跳链。
 *
 * 发起即写（status=running，nodeId=taskId）；完成时删除本记录并以真实
 * kernel-run/verdict 节点收口（同指纹幂等）；取消/失败时保留本记录如实标注
 * （cancelReason + 已完成重复数），不伪造成 completed，也不伪造判定。
 */
export interface AiProvenanceStudyRunRecord {
  kind: "study-run";
  nodeId: string;
  proposalFingerprint: string;
  inputFingerprint: string;
  status: "running" | "cancelled" | "failed";
  totalRepeats: number;
  completedRepeats: number;
  seed?: string;
  replications?: number;
  startedAt: string;
  settledAt?: string;
  /** 收口理由：user / budget-exceeded / provider-blocked / provider-failed 等；≤200 字符。 */
  settleReason?: string;
  /** 完成收口时随行（记录随即删除，此字段只在 cancelled/failed 保留时为空）。 */
  resultFingerprint?: string;
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

  /**
   * 长跑发起落账（simulation.study.run-async 发起处）：假设节点 + 运行中记录同事务成"进行中链"。
   * 同 proposalFingerprint 重提复用 recordHypothesis 的去重语义；同 taskId 幂等（重复发起恢复不重复成链）。
   */
  async recordStudyLaunched(
    projectId: string,
    input: {
      contract: AiHypothesisContract;
      proposalFingerprint: string;
      inputFingerprint: string;
      taskId: string;
      totalRepeats: number;
      seed?: string;
      replications?: number;
      startedAt: string;
    },
  ): Promise<void> {
    const node = buildAiProvenanceHypothesisNode(input.contract, input.proposalFingerprint, input.startedAt);
    const studyRun: AiProvenanceStudyRunRecord = {
      kind: "study-run",
      nodeId: requireStudyTaskId(input.taskId),
      proposalFingerprint: requireFingerprint(input.proposalFingerprint, "proposalFingerprint"),
      inputFingerprint: requireFingerprint(input.inputFingerprint, "inputFingerprint"),
      status: "running",
      totalRepeats: input.totalRepeats,
      completedRepeats: 0,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.replications !== undefined ? { replications: input.replications } : {}),
      startedAt: input.startedAt,
    };
    await this.#commit(projectId, (draft) => {
      if (!draft.hypotheses.some((item) => item.proposalFingerprint === node.proposalFingerprint)) {
        draft.hypotheses.push(node);
        this.#evictOldestChains(draft);
      }
      upsertById(draft.studyRuns, studyRun);
      pruneOrphanedStudyRuns(draft);
    });
  }

  /**
   * 长跑完成收口：删除运行中记录 + 落真实运行/判定节点（复用幂等 upsert，同指纹续写不重复成链）。
   * 运行/判定构建与 recordVerification 同源（contracts 装配函数），断线恢复后指纹不变。
   */
  async recordStudySettled(
    projectId: string,
    input: { taskId: string; envelope: AiVerificationEnvelope; contract?: AiHypothesisContract; seed?: string; replications?: number; settledAt: string },
  ): Promise<{ run: AiProvenanceKernelRunNode; verdict: AiProvenanceVerdictNode }> {
    const { envelope } = input;
    const run = buildAiProvenanceKernelRunNode(envelope, {
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.replications !== undefined ? { replications: input.replications } : {}),
      executedAt: input.settledAt,
    });
    const verdict = buildAiProvenanceVerdictNode(envelope, input.settledAt);
    await this.#commit(projectId, (draft) => {
      const existing = draft.hypotheses.find((item) => item.proposalFingerprint === envelope.proposalFingerprint);
      if (!existing && input.contract) draft.hypotheses.push(buildAiProvenanceHypothesisNode(input.contract, envelope.proposalFingerprint, input.settledAt));
      else if (existing && !existing.verifiedAt) draft.hypotheses[draft.hypotheses.indexOf(existing)] = { ...existing, verifiedAt: input.settledAt };
      draft.studyRuns = draft.studyRuns.filter((item) => item.nodeId !== requireStudyTaskId(input.taskId));
      upsertById(draft.runs, run);
      upsertById(draft.verdicts, verdict);
      this.#evictOldestChains(draft);
      pruneOrphanedStudyRuns(draft);
      return { run, verdict };
    });
    return { run, verdict };
  }

  /** 长跑取消/失败收口：保留运行段记录如实标注（取消态/失败态），不伪造成 completed、不伪造判定。 */
  async recordStudyHalted(
    projectId: string,
    input: { taskId: string; status: "cancelled" | "failed"; settleReason: string; completedRepeats: number; settledAt: string },
  ): Promise<void> {
    await this.#commit(projectId, (draft) => {
      const record = draft.studyRuns.find((item) => item.nodeId === requireStudyTaskId(input.taskId));
      if (record) {
        const halted: AiProvenanceStudyRunRecord = {
          ...record,
          status: input.status,
          completedRepeats: input.completedRepeats,
          settleReason: input.settleReason.slice(0, 200),
          settledAt: input.settledAt,
        };
        draft.studyRuns[draft.studyRuns.indexOf(record)] = halted;
      }
    });
  }

  /** 运行段查询（进行中链的读取口径；合同三跳链仍走 trace）。 */
  async listStudyRuns(projectId: string, options: { status?: AiProvenanceStudyRunRecord["status"] } = {}): Promise<AiProvenanceStudyRunRecord[]> {
    const document = await this.#loadDocument(projectId);
    return structuredClone(document.studyRuns).filter((item) => !options.status || item.status === options.status);
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

  /**
   * 串行化提交：读档→clone→mutate→persist 全程在写链内执行（真串行读改写）。
   * 落账调用方可能并发（H-C3b 异步长跑收口与网关同步验证同时落账）：若在链外
   * 读档/clone（先读后排队写），并发提交各自基于陈旧文档整文件覆盖，互相抹掉
   * 对方节点（lost update），且容量逐出永远数不到并发中的新增链。与
   * simulationStudyTasks 同一纪律—— mutate 只许改 draft，"检查时看到的是已提交最新值"。
   */
  async #commit<T>(projectId: string, mutate: (draft: ProvenanceDocument) => T): Promise<T> {
    const operation = this.#writes.then(async () => {
      const document = await this.#loadDocument(projectId);
      const draft: ProvenanceDocument = structuredClone(document);
      const result = mutate(draft);
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
      return result;
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #loadDocument(projectId: string): Promise<ProvenanceDocument> {
    const cached = this.#documents.get(projectId);
    if (cached) return cached;
    const filePath = this.#documentPath(projectId);
    let document: ProvenanceDocument = { schemaVersion: 1, hypotheses: [], runs: [], verdicts: [], reports: [], studyRuns: [] };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<ProvenanceDocument>;
      if (parsed.schemaVersion === 1) {
        document = {
          schemaVersion: 1,
          hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses.filter(isHypothesisNode) : [],
          runs: Array.isArray(parsed.runs) ? parsed.runs.filter(isRunNode) : [],
          verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts.filter(isVerdictNode) : [],
          reports: Array.isArray(parsed.reports) ? parsed.reports.filter(isReportNode) : [],
          studyRuns: Array.isArray(parsed.studyRuns) ? parsed.studyRuns.filter(isStudyRunRecord) : [],
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

/** 长跑运行段记录的 fail-closed 形状过滤：损坏行直接丢弃，不带病入账。 */
function isStudyRunRecord(value: unknown): value is AiProvenanceStudyRunRecord {
  if (!value || typeof value !== "object") return false;
  const node = value as Partial<AiProvenanceStudyRunRecord>;
  return node.kind === "study-run"
    && typeof node.nodeId === "string"
    && typeof node.proposalFingerprint === "string"
    && typeof node.inputFingerprint === "string"
    && (node.status === "running" || node.status === "cancelled" || node.status === "failed")
    && typeof node.totalRepeats === "number"
    && typeof node.completedRepeats === "number"
    && typeof node.startedAt === "string";
}

/** 假设被逐出后，其运行段记录成为孤儿：随逐出一起清理，不静默残留。 */
function pruneOrphanedStudyRuns(draft: ProvenanceDocument): void {
  const known = new Set(draft.hypotheses.map((item) => item.proposalFingerprint));
  draft.studyRuns = draft.studyRuns.filter((item) => known.has(item.proposalFingerprint));
}

const STUDY_TASK_ID_PATTERN = /^study-[0-9a-f]{16}$/;

function requireStudyTaskId(value: string): string {
  if (!STUDY_TASK_ID_PATTERN.test(value)) throw new ProvenanceLedgerError("任务句柄必须是 study-<16 位小写十六进制>");
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
