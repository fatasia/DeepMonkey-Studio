import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateAiHypothesisContract,
  validateAiVerificationEnvelope,
  aiHypothesisProposalFingerprint,
  type AiHypothesisContract,
  type AiHypothesisContractError,
  type AiVerificationEnvelope,
} from "@bim-studio/contracts";
import { CALIBRATION_RUN, CALIBRATION_SEED } from "@bim-studio/plant-lite-simulation";
import { goldenVerifyInputFingerprint } from "./simulationHypothesisPlugin.js";
import type { ProvenanceLedgerStore } from "./provenanceLedger.js";
import type { CapabilityContext, CapabilityProvider, CapabilityRequest } from "@bim-studio/plugin-runtime";

/**
 * H-C3 后续切片：MCP Tasks 异步长跑（durable 句柄 + 轮询 + mid-flight 取消）。
 *
 * 长仿真（分钟级 DES/物理验证的 CPU 短仿真代理）不再阻塞 MCP 调用：发起即落
 * durable 任务记录并返回句柄，客户端以 simulation.study.status 轮询进度，
 * simulation.study.cancel 可中途取消（停止调度 + 部分证据如实标注 partial）。
 *
 * 存储复用 agentMemory/provenanceLedger 纪律：dataDir 下每项目一份 JSON，
 * 原子写（tmp+rename）、串行化提交、内存缓存、加载时 fail-closed 形状过滤。
 *
 * 恢复不变量：任务输入（假设合同 + 预算）随任务落盘；宿主重启后 init() 把
 * 磁盘上仍为 running 的任务原样重新调度（确定性研究同输入→同结果指纹），
 * 账本按幂等 upsert 续写——链不重复、指纹不变。
 *
 * 预算与保安（fail-closed）：repeats/wallClockMs 双上限（超限即取消并如实标注
 * budget-exceeded）、每项目并发上限；取消按提交者 principal 或 admin 校验。
 *
 * 诚实条款：任务记录保存假设合同原文仅为断线恢复所需（操作态存储边界，与
 * 档案账本的"只存指纹+摘要"纪律区分并在此声明）；取消/失败不伪造成 completed，
 * 失败理由截断到 200 字符入账本与任务记录。
 */

/** 任务句柄形态：study-<16 位小写十六进制>。 */
export const STUDY_TASK_ID_PATTERN = /^study-[0-9a-f]{16}$/;
/** repeats 上限：单任务最大重复次数。 */
export const STUDY_MAX_REPEATS = 3_600;
/** wallClock 上限：单任务墙钟预算上限（毫秒）。 */
export const STUDY_MAX_WALL_CLOCK_MS = 600_000;
/** 每项目并发运行上限（超出 fail-closed 拒绝发起，不排队）。 */
export const STUDY_MAX_RUNNING_PER_PROJECT = 3;

export type SimulationStudyTaskStatus = "running" | "completed" | "cancelled" | "failed";

export interface SimulationStudyTaskRecord {
  taskId: string;
  projectId: string;
  status: SimulationStudyTaskStatus;
  /** 提交者 principal（MCP/网关传入）；取消按提交者或 admin 校验；不下发到轮询输出。 */
  principal: string;
  /** 假设合同：断线恢复重调度所需（诚实边界见文件头注）。 */
  hypothesis: AiHypothesisContract;
  proposalFingerprint: string;
  inputFingerprint: string;
  budget: { repeats: number; wallClockMs: number };
  progress: { completedRepeats: number; totalRepeats: number };
  /** true = 已产出部分证据（运行中或被取消/失败且 completedRepeats>0）；completed 时为 false。 */
  partial: boolean;
  createdAt: string;
  startedAt: string;
  settledAt?: string;
  /** 取消/失败理由：user / budget-exceeded / concurrency-cap / provider-*；≤200 字符。 */
  settleReason?: string;
  /** 账本/调度过程中的如实告警（不阻断主链路）。 */
  warnings: string[];
  resultFingerprint?: string;
  /** 完成时随任务保存的验证信封（轮询取走判定用；取消/失败不得出现）。 */
  envelope?: AiVerificationEnvelope;
}

interface StudyTaskDocument {
  schemaVersion: 1;
  tasks: SimulationStudyTaskRecord[];
}

export class SimulationStudyTaskError extends Error {
  constructor(
    readonly code:
      | "invalid-hypothesis"
      | "invalid-task-id"
      | "task-not-found"
      | "task-already-completed"
      | "task-already-cancelled"
      | "task-not-owner"
      | "concurrency-cap"
      | "store-failed",
    message: string,
  ) {
    super(message);
    this.name = "SimulationStudyTaskError";
  }
}

export interface SimulationStudyTaskStoreOptions {
  /** 墙钟来源（可注入测试时钟）；epoch 毫秒。 */
  now?: () => number;
  /** 每步之间的让出间隔（毫秒，默认 0：仅让出事件循环）。给轮询/取消留出进入窗口。 */
  stepDelayMs?: number;
  maxRunningPerProject?: number;
}

export interface SimulationStudyLaunchInput {
  hypothesis: unknown;
  budget?: { repeats?: unknown; wallClockMs?: unknown };
}

export interface SimulationStudyCancelInput {
  principal: string;
  role?: string;
}

/** 轮询输出：任务记录投影（省略 principal，证据最小化口径）。 */
export type SimulationStudyTaskView = Omit<SimulationStudyTaskRecord, "principal">;

export class SimulationStudyTaskStore {
  readonly #root: string;
  readonly #ledger: ProvenanceLedgerStore | undefined;
  readonly #golden: CapabilityProvider<{ hypothesis: unknown }>;
  readonly #now: () => number;
  readonly #stepDelayMs: number;
  readonly #maxRunningPerProject: number;
  readonly #documents = new Map<string, StudyTaskDocument>();
  readonly #active = new Map<string, AbortController>();
  #writes: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    options: SimulationStudyTaskStoreOptions & { ledger?: ProvenanceLedgerStore; goldenProvider: CapabilityProvider<{ hypothesis: unknown }> },
  ) {
    this.#root = path.join(dataDir, "simulation-study-tasks");
    this.#ledger = options.ledger;
    this.#golden = options.goldenProvider;
    this.#now = options.now ?? (() => Date.now());
    this.#stepDelayMs = Math.max(0, Math.floor(options.stepDelayMs ?? 0));
    this.#maxRunningPerProject = Math.max(1, Math.floor(options.maxRunningPerProject ?? STUDY_MAX_RUNNING_PER_PROJECT));
  }

  /** 加载落盘任务并把仍为 running 的任务原样重新调度（宿主重启 → 同指纹续写）。 */
  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const projectIds = await listProjectDirectories(this.#root);
    for (const projectId of projectIds) {
      const document = await this.#loadDocument(projectId);
      for (const task of document.tasks) {
        if (task.status !== "running") continue;
        await this.#commit(projectId, (draft) => {
          const record = draft.tasks.find((item) => item.taskId === task.taskId);
          if (record && record.status === "running") {
            record.warnings = [...record.warnings.filter((item) => item !== "resumed-after-restart"), "resumed-after-restart"];
            record.progress = { completedRepeats: 0, totalRepeats: record.budget.repeats };
            record.partial = false;
          }
        });
        this.#schedule(new SimulationStudyTaskRef(projectId, task.taskId));
      }
    }
  }

  /** 停止调度（进程退出/测试清理）：中断在跑步骤，落盘状态保持 running，由重启方接管收口。 */
  dispose(): number {
    const controllers = [...this.#active.values()];
    this.#active.clear();
    for (const controller of controllers) controller.abort();
    return controllers.length;
  }

  /** 发起长跑：校验 → 并发闸 → 落盘 → 账本"进行中链" → 返回 durable 句柄（不等待完成）。 */
  async launch(projectId: string, principal: string, input: SimulationStudyLaunchInput): Promise<SimulationStudyTaskRecord> {
    let contract: AiHypothesisContract;
    try {
      contract = validateAiHypothesisContract(input.hypothesis);
    } catch (error) {
      const detail = error as AiHypothesisContractError;
      throw new SimulationStudyTaskError("invalid-hypothesis", `${detail.field ?? "hypothesis"}: ${detail.message}`);
    }
    const budget = clampBudget(input.budget);
    const proposalFingerprint = aiHypothesisProposalFingerprint(contract);
    const inputFingerprint = goldenVerifyInputFingerprint(contract.targetModel);
    const nowMs = this.#now();
    const startedAt = new Date(nowMs).toISOString();
    const record: SimulationStudyTaskRecord = {
      taskId: `study-${randomBytes(8).toString("hex")}`,
      projectId,
      status: "running",
      principal,
      hypothesis: contract,
      proposalFingerprint,
      inputFingerprint,
      budget,
      progress: { completedRepeats: 0, totalRepeats: budget.repeats },
      partial: false,
      createdAt: startedAt,
      startedAt,
      warnings: [],
    };
    // 先落 durable 任务记录（含并发闸），账本随后补写"进行中链"——并发被拒时不会留下孤儿运行段。
    await this.#commit(projectId, (draft) => {
      const running = draft.tasks.filter((item) => item.status === "running").length;
      if (running >= this.#maxRunningPerProject) {
        throw new SimulationStudyTaskError("concurrency-cap", `项目 ${projectId} 并发长跑已达上限 ${this.#maxRunningPerProject}，请先等待或取消既有任务`);
      }
      draft.tasks.push(record);
      if (draft.tasks.length > 200) {
        // 容量逐出只动已收口任务；运行中的任务不受逐出影响（循环仍需读其字段）。
        const running = draft.tasks.filter((item) => item.status === "running");
        const settled = draft.tasks.filter((item) => item.status !== "running").slice(-(200 - Math.min(running.length, 200)));
        draft.tasks = [...running, ...settled];
      }
    });
    if (this.#ledger) {
      try {
        await this.#ledger.recordStudyLaunched(projectId, {
          contract,
          proposalFingerprint,
          inputFingerprint,
          taskId: record.taskId,
          totalRepeats: budget.repeats,
          seed: CALIBRATION_SEED,
          replications: CALIBRATION_RUN.replications,
          startedAt,
        });
      } catch (error) {
        await this.#appendWarning(projectId, record.taskId, `provenance-ledger-write-failed(study-launch): ${compactMessage(error)}`);
      }
    }
    this.#schedule(new SimulationStudyTaskRef(projectId, record.taskId));
    return structuredClone(record);
  }

  /** 轮询：未知句柄返回 undefined（调用方如实呈现"任务不存在"）。 */
  async status(projectId: string, taskId: string): Promise<SimulationStudyTaskView | undefined> {
    if (!STUDY_TASK_ID_PATTERN.test(taskId)) throw new SimulationStudyTaskError("invalid-task-id", "任务句柄必须是 study-<16 位小写十六进制>");
    const document = await this.#loadDocument(projectId);
    const record = document.tasks.find((item) => item.taskId === taskId);
    return record ? toView(record) : undefined;
  }

  /** 取消：停止调度 + 部分证据如实标注 partial；完成态取消不生效（如实返回 already-completed）。 */
  async cancel(projectId: string, taskId: string, caller: SimulationStudyCancelInput): Promise<SimulationStudyTaskView> {
    if (!STUDY_TASK_ID_PATTERN.test(taskId)) throw new SimulationStudyTaskError("invalid-task-id", "任务句柄必须是 study-<16 位小写十六进制>");
    const document = await this.#loadDocument(projectId);
    const record = document.tasks.find((item) => item.taskId === taskId);
    if (!record) throw new SimulationStudyTaskError("task-not-found", `任务 ${taskId} 不存在`);
    if (record.principal !== caller.principal && caller.role !== "admin") {
      throw new SimulationStudyTaskError("task-not-owner", "只有任务提交者或管理员可以取消该任务");
    }
    if (record.status === "cancelled") return toView(record);
    if (record.status !== "running") {
      throw new SimulationStudyTaskError("task-already-completed", `任务已收口（${record.status}），取消不生效`);
    }
    await this.#halt(projectId, taskId, "cancelled", "user");
    // 提交后重读缓存最新值：取消与完成步进竞速时，以磁盘真实收口态如实回执。
    const fresh = await this.#loadDocument(projectId);
    const updated = fresh.tasks.find((item) => item.taskId === taskId);
    if (updated && updated.status === "completed") {
      throw new SimulationStudyTaskError("task-already-completed", "任务在取消生效前已完成");
    }
    return toView(updated ?? record);
  }

  async #halt(projectId: string, taskId: string, status: "cancelled" | "failed", settleReason: string, extraWarnings: string[] = []): Promise<void> {
    this.#active.get(taskId)?.abort();
    // F1（HEAD 卫生批捕获的负载型竞态，test-output/api-flaky-analysis.md）：旧实现先提交任务
    // 视图再写账本——观察者在两步之间轮询会看到"任务已 cancelled、账本行仍 running"的
    // 不一致链（测试 :227 即断在该窗口）。收口改为单段串行写链：账本先落、任务视图后翻转
    // （与完成路径 recordStudySettled→commit 同序），视图可见时账本必然已写穿透；
    // completedRepeats 与状态翻转同读同写，保持原子精确（用户取消回执 equality 依赖它）。
    // 账本写失败不阻断收口：警告随翻转原子入档（fail-open + 诚实警示，K8 纪律）。
    let ledgerWarning: string | undefined;
    const operation = this.#writes.then(async () => {
      const document = await this.#loadDocument(projectId);
      const record = document.tasks.find((item) => item.taskId === taskId);
      // 非运行态直接跳过：竞态双收口（取消 vs 预算看门狗）不会用陈旧计数覆盖首次精确回执。
      if (!record || record.status !== "running") return;
      const completedRepeats = record.progress.completedRepeats;
      const settledAt = new Date(this.#now()).toISOString();
      if (this.#ledger) {
        try {
          await this.#ledger.recordStudyHalted(projectId, { taskId, status, settleReason, completedRepeats, settledAt });
        } catch (error) {
          ledgerWarning = `provenance-ledger-write-failed(study-halt): ${compactMessage(error)}`;
        }
      }
      const draft: StudyTaskDocument = structuredClone(document);
      const draftRecord = draft.tasks.find((item) => item.taskId === taskId)!;
      draftRecord.status = status;
      draftRecord.settleReason = settleReason.slice(0, 200);
      draftRecord.settledAt = settledAt;
      draftRecord.partial = completedRepeats > 0;
      draftRecord.warnings = [...draftRecord.warnings, ...extraWarnings, ...(ledgerWarning ? [ledgerWarning] : [])].slice(-20);
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async #appendWarning(projectId: string, taskId: string, warning: string): Promise<void> {
    await this.#commit(projectId, (draft) => {
      const record = draft.tasks.find((item) => item.taskId === taskId);
      if (record) record.warnings = [...record.warnings, warning].slice(-20);
    });
  }

  /** 后台执行循环：每步让出事件循环（可取消窗口），预算超限 fail-closed 取消。 */
  #schedule(ref: SimulationStudyTaskRef): void {
    const controller = new AbortController();
    this.#active.set(ref.taskId, controller);
    void this.#run(ref, controller)
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        await this.#halt(ref.projectId, ref.taskId, "failed", compactMessage(error));
      })
      .finally(() => {
        if (this.#active.get(ref.taskId) === controller) this.#active.delete(ref.taskId);
      });
  }

  async #run(ref: SimulationStudyTaskRef, controller: AbortController): Promise<void> {
    const launchedAt = this.#now();
    let lastEnvelope: AiVerificationEnvelope | undefined;
    for (let step = 0; step < this.#budgetOf(ref).repeats; step++) {
      if (controller.signal.aborted) return;
      const budget = this.#budgetOf(ref);
      if (this.#now() - launchedAt >= budget.wallClockMs) {
        await this.#halt(ref.projectId, ref.taskId, "cancelled", "budget-exceeded", ["墙钟预算耗尽，已按 fail-closed 取消"]);
        return;
      }
      if (this.#stepDelayMs > 0) await sleep(this.#stepDelayMs, controller.signal);
      if (controller.signal.aborted) return;
      const request: CapabilityRequest<{ hypothesis: unknown }> = {
        requestId: `${ref.taskId}:${step}`,
        projectId: ref.projectId,
        principal: this.#principalOf(ref),
        input: { hypothesis: this.#hypothesisOf(ref) },
      };
      const context: CapabilityContext = {
        pluginId: "bim.ai.simulation-study",
        pluginVersion: "1.0.0",
        descriptor: this.#golden.descriptor,
        signal: controller.signal,
      };
      const result = await this.#golden.invoke(request, context);
      if (controller.signal.aborted) return;
      if (result.status !== "completed") {
        const detail = (result.warnings ?? []).join("；") || `provider-${result.status}`;
        await this.#halt(ref.projectId, ref.taskId, "failed", `provider-${result.status}`, [detail.slice(0, 200)]);
        return;
      }
      // fail-closed 双保险：信封不过在出边界前重验即按失败收口，不带病入账。
      lastEnvelope = validateAiVerificationEnvelope(result.output);
      const completedRepeats = step + 1;
      await this.#commit(ref.projectId, (draft) => {
        const record = draft.tasks.find((item) => item.taskId === ref.taskId);
        if (!record || record.status !== "running") return;
        record.progress.completedRepeats = completedRepeats;
        record.partial = true;
      });
    }
    const envelope = lastEnvelope;
    if (!envelope) throw new SimulationStudyTaskError("store-failed", "长跑结束但未产出验证信封");
    if (this.#ledger) {
      try {
        await this.#ledger.recordStudySettled(ref.projectId, {
          taskId: ref.taskId,
          envelope,
          ...(this.#hypothesisOf(ref) !== undefined ? { contract: this.#hypothesisOf(ref) as AiHypothesisContract } : {}),
          seed: CALIBRATION_SEED,
          replications: CALIBRATION_RUN.replications,
          settledAt: new Date(this.#now()).toISOString(),
        });
      } catch (error) {
        await this.#appendWarning(ref.projectId, ref.taskId, `provenance-ledger-write-failed(study-settle): ${compactMessage(error)}`);
      }
    }
    await this.#commit(ref.projectId, (draft) => {
      const record = draft.tasks.find((item) => item.taskId === ref.taskId);
      if (!record || record.status !== "running") return;
      record.status = "completed";
      record.settledAt = new Date(this.#now()).toISOString();
      record.progress.completedRepeats = record.budget.repeats;
      record.partial = false;
      record.resultFingerprint = envelope.resultFingerprint;
      record.envelope = envelope;
    });
  }

  // 任务原始字段读取：循环内部以磁盘当前值为准（取消/预算都作用于最新记录）。
  #recordOf(ref: SimulationStudyTaskRef): SimulationStudyTaskRecord | undefined {
    return this.#documents.get(ref.projectId)?.tasks.find((item) => item.taskId === ref.taskId);
  }
  #budgetOf(ref: SimulationStudyTaskRef): { repeats: number; wallClockMs: number } {
    return this.#recordOf(ref)?.budget ?? { repeats: 0, wallClockMs: Number.MAX_SAFE_INTEGER };
  }
  #principalOf(ref: SimulationStudyTaskRef): string {
    return this.#recordOf(ref)?.principal ?? "study-internal";
  }
  #hypothesisOf(ref: SimulationStudyTaskRef): unknown {
    return this.#recordOf(ref)?.hypothesis ?? {};
  }

  /**
   * 串行化提交：clone→mutate→persist 全程在写链内执行（真串行读改写）。
   * 并发闸、进度步进、取消收口都依赖"检查时看到的是已提交最新值"——
   * 若在链外 clone（先读后排队写），并发提交会互相覆盖（lost update）且
   * 并发闸永远数不到在跑任务。此为 agentMemory/账本纪律在本存储上的收紧版。
   */
  async #commit<T>(projectId: string, mutate: (draft: StudyTaskDocument) => T): Promise<T> {
    const operation = this.#writes.then(async () => {
      const document = await this.#loadDocument(projectId);
      const draft: StudyTaskDocument = structuredClone(document);
      const result = mutate(draft);
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
      return result;
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #loadDocument(projectId: string): Promise<StudyTaskDocument> {
    const cached = this.#documents.get(projectId);
    if (cached) return cached;
    const filePath = this.#documentPath(projectId);
    let document: StudyTaskDocument = { schemaVersion: 1, tasks: [] };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StudyTaskDocument>;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.tasks)) {
        document = { schemaVersion: 1, tasks: parsed.tasks.filter(isStudyTaskRecord) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 落盘损坏按 fail-closed 处理：拒绝在坏档上继续写（不静默重置）。
        throw new SimulationStudyTaskError("store-failed", `任务档 ${filePath} 读取失败：${compactMessage(error)}`);
      }
    }
    this.#documents.set(projectId, document);
    return document;
  }

  async #persist(projectId: string, document: StudyTaskDocument): Promise<void> {
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
    return path.join(this.#root, sanitizeDir(projectId), "tasks.json");
  }
}

/** 调度引用：只携带定位键，循环内部字段一律读磁盘最新值（避免跨步陈旧快照）。 */
class SimulationStudyTaskRef {
  constructor(readonly projectId: string, readonly taskId: string) {}
}

function toView(record: SimulationStudyTaskRecord): SimulationStudyTaskView {
  const { principal: _principal, ...view } = record;
  return structuredClone(view);
}

function clampBudget(input: SimulationStudyLaunchInput["budget"]): { repeats: number; wallClockMs: number } {
  return {
    repeats: clampInteger(input?.repeats, 1, STUDY_MAX_REPEATS, 1),
    wallClockMs: clampInteger(input?.wallClockMs, 1_000, STUDY_MAX_WALL_CLOCK_MS, 120_000),
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (signal.aborted) {
      clearTimeout(handle);
      resolve();
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(handle);
      resolve();
    }, { once: true });
  });
}

function compactMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function sanitizeDir(projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(projectId) || projectId.includes("..")) {
    throw new SimulationStudyTaskError("store-failed", "项目标识不合法，无法定位任务目录");
  }
  return projectId;
}

async function listProjectDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isStudyTaskRecord(value: unknown): value is SimulationStudyTaskRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SimulationStudyTaskRecord>;
  return typeof record.taskId === "string"
    && typeof record.projectId === "string"
    && (record.status === "running" || record.status === "completed" || record.status === "cancelled" || record.status === "failed")
    && typeof record.principal === "string"
    && record.hypothesis !== undefined
    && typeof record.proposalFingerprint === "string"
    && typeof record.inputFingerprint === "string"
    && record.budget !== undefined
    && record.progress !== undefined
    && typeof record.partial === "boolean"
    && typeof record.createdAt === "string"
    && typeof record.startedAt === "string"
    && Array.isArray(record.warnings);
}
