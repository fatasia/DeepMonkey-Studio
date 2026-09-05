import { parseAgentDecision } from "./decision.js";
import { AgentDecisionUnavailableError, AgentRunError } from "./errors.js";
import { prepareAgentRecovery } from "./recovery.js";
import { normalizeAllowedTools, normalizeApproval, normalizeBudget, requiredText, safeClone } from "./runValidation.js";
import type {
  AgentApproval,
  AgentCheckpoint,
  AgentCheckpointStore,
  AgentDecision,
  AgentDecisionProvider,
  AgentPendingTool,
  AgentToolDefinition,
  AgentToolGateway,
  StartAgentRunInput,
  ResumeAgentRunOptions,
} from "./types.js";

export class IndustrialAgentOrchestrator {
  readonly #running = new Map<string, Promise<AgentCheckpoint>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #resuming = new Set<string>();

  constructor(private readonly dependencies: {
    decisions: AgentDecisionProvider;
    tools: AgentToolGateway;
    checkpoints: AgentCheckpointStore;
    now?: () => Date;
    createId?: () => string;
  }) {}

  async start(input: StartAgentRunInput): Promise<AgentCheckpoint> {
    const checkpoint = await this.initialize(input);
    return this.drive(checkpoint.id, input.signal);
  }

  /**
   * 先持久化可查询的 checkpoint，再在后台推进。
   * HTTP/UI 可据此立即获得运行 ID，支持进度、刷新恢复和运行中取消。
   */
  async startDetached(input: StartAgentRunInput): Promise<AgentCheckpoint> {
    const checkpoint = await this.initialize(input);
    void this.drive(checkpoint.id).catch(() => undefined);
    return checkpoint;
  }

  private async initialize(input: StartAgentRunInput): Promise<AgentCheckpoint> {
    const now = this.now();
    const checkpoint: AgentCheckpoint = {
      schemaVersion: 1,
      id: this.dependencies.createId?.() ?? createRunId(),
      projectId: requiredText(input.projectId, "项目 ID", 200),
      principal: requiredText(input.principal, "执行人", 200),
      ...(input.role?.trim() ? { role: input.role.trim().slice(0, 100) } : {}),
      objective: requiredText(input.objective, "Agent 目标", 4_000),
      context: safeClone(input.context ?? {}),
      status: "running",
      budget: normalizeBudget(input.budget),
      usage: { steps: 0, toolCalls: 0, activeDurationMs: 0 },
      allowedToolIds: normalizeAllowedTools(input.allowedToolIds, this.dependencies.tools.list()),
      decisions: [],
      toolRecords: [],
      seenToolFingerprints: [],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await this.dependencies.checkpoints.save(checkpoint);
    return structuredClone(checkpoint);
  }

  async get(runId: string): Promise<AgentCheckpoint | undefined> {
    return this.dependencies.checkpoints.get(runId);
  }

  async resume(runId: string, options: ResumeAgentRunOptions = {}): Promise<AgentCheckpoint> {
    return this.resumeRun(runId, options, false);
  }

  /** 审批或恢复请求立即返回 checkpoint，后续仍由同一受控驱动器推进。 */
  async resumeDetached(runId: string, options: ResumeAgentRunOptions = {}): Promise<AgentCheckpoint> {
    return this.resumeRun(runId, options, true);
  }

  private async resumeRun(runId: string, options: ResumeAgentRunOptions, detached: boolean): Promise<AgentCheckpoint> {
    if (this.#resuming.has(runId) || this.#running.has(runId)) throw new AgentRunError("run-busy", "Agent 运行正在推进，请稍后读取 checkpoint");
    this.#resuming.add(runId);
    try {
      const checkpoint = await this.prepareResume(runId, options);
      if (checkpoint.status !== "running") return checkpoint;
      const run = this.drive(runId, options.signal);
      if (!detached) return await run;
      void run.catch(() => undefined);
      return checkpoint;
    } finally { this.#resuming.delete(runId); }
  }

  private async prepareResume(runId: string, options: ResumeAgentRunOptions): Promise<AgentCheckpoint> {
    const checkpoint = await this.require(runId);
    if (prepareAgentRecovery(checkpoint, options, this.now())) {
      await this.save(checkpoint);
      return structuredClone(checkpoint);
    }
    const approval = options.approval;
    if (terminal(checkpoint.status)) return checkpoint;
    if (checkpoint.status === "awaiting-approval") {
      if (!approval) return checkpoint;
      if (!checkpoint.pendingTool || checkpoint.pendingTool.fingerprint !== approval.scopeFingerprint) {
        throw new AgentRunError("approval-mismatch", "审批范围与等待中的工具参数不一致");
      }
      checkpoint.pendingTool.approval = normalizeApproval(approval);
      checkpoint.pendingTool.state = "ready";
      checkpoint.status = "running";
      await this.save(checkpoint);
    } else if (approval) {
      throw new AgentRunError("invalid-state", "当前运行没有等待审批的工具调用");
    }
    return structuredClone(checkpoint);
  }

  async cancel(runId: string, cancelledBy: string): Promise<AgentCheckpoint> {
    if (this.#resuming.has(runId) && !this.#controllers.has(runId)) throw new AgentRunError("run-busy", "检查点正在恢复，请稍后重试取消");
    const checkpoint = await this.require(runId);
    if (terminal(checkpoint.status)) return checkpoint;
    this.#controllers.get(runId)?.abort(new Error(`运行已由 ${requiredText(cancelledBy, "取消人", 200)} 取消`));
    checkpoint.status = "cancelled";
    checkpoint.failure = { code: "cancelled", message: "Agent 运行已取消", retryable: false };
    delete checkpoint.pendingTool;
    delete checkpoint.pendingSelection;
    await this.save(checkpoint);
    return checkpoint;
  }

  private async drive(runId: string, callerSignal?: AbortSignal): Promise<AgentCheckpoint> {
    if (this.#running.has(runId)) throw new AgentRunError("run-busy", "Agent 运行正在推进，请稍后读取 checkpoint");
    const pending = this.driveExclusive(runId, callerSignal);
    this.#running.set(runId, pending);
    try { return await pending; }
    finally { this.#running.delete(runId); }
  }

  private async driveExclusive(runId: string, callerSignal?: AbortSignal): Promise<AgentCheckpoint> {
    let checkpoint = await this.require(runId);
    const segmentStarted = Date.now();
    const initialActiveDuration = checkpoint.usage.activeDurationMs;
    const controller = new AbortController();
    this.#controllers.set(runId, controller);
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const remaining = Math.max(1, checkpoint.budget.maxDurationMs - initialActiveDuration);
    let budgetTimedOut = false;
    const timeout = setTimeout(() => {
      budgetTimedOut = true;
      controller.abort(new Error("Agent 已达到时间预算"));
    }, remaining);
    const persist = async () => {
      checkpoint.usage.activeDurationMs = budgetTimedOut ? checkpoint.budget.maxDurationMs : Math.min(
        checkpoint.budget.maxDurationMs,
        initialActiveDuration + Math.max(0, Date.now() - segmentStarted),
      );
      await this.save(checkpoint);
    };

    try {
      while (checkpoint.status === "running") {
        if (controller.signal.aborted) {
          checkpoint = await this.abortCheckpoint(checkpoint, budgetTimedOut);
          break;
        }
        if (checkpoint.pendingTool) {
          if (checkpoint.pendingTool.state === "awaiting-approval" && !checkpoint.pendingTool.approval) {
            checkpoint.status = "awaiting-approval";
            await persist();
            break;
          }
          if (checkpoint.pendingTool.state === "executing") {
            if (["write", "control"].includes(checkpoint.pendingTool.effect)) {
              checkpoint = fail(checkpoint, "blocked", "indeterminate-side-effect", "服务重启前的写入或控制结果未知，必须先人工核验现场状态", false);
              await persist();
              break;
            }
            // 只读、分析和仿真可以从持久化调用输入安全重试。
            checkpoint.pendingTool.state = "ready";
          }
          checkpoint = await this.executePending(checkpoint, controller.signal, persist);
          if (budgetTimedOut && checkpoint.status === "cancelled") {
            checkpoint = fail(checkpoint, "budget-exhausted", "time-budget", "Agent 已达到时间预算", false);
            await persist();
          }
          continue;
        }
        if (checkpoint.usage.steps >= checkpoint.budget.maxSteps) {
          checkpoint = fail(checkpoint, "budget-exhausted", "step-budget", "Agent 已达到最大步骤数", false);
          await persist();
          break;
        }
        const availableTools = this.allowedDefinitions(checkpoint);
        let decision: AgentDecision;
        try {
          decision = parseAgentDecision(await raceAbort(this.dependencies.decisions.decide({
            checkpoint: structuredClone(checkpoint),
            availableTools,
            signal: controller.signal,
          }), controller.signal));
        } catch (error) {
          checkpoint = controller.signal.aborted
            ? fail(checkpoint, budgetTimedOut ? "budget-exhausted" : "cancelled", budgetTimedOut ? "time-budget" : "cancelled", budgetTimedOut ? "Agent 已达到时间预算" : message(error), false)
            : fail(checkpoint, "failed", error instanceof AgentDecisionUnavailableError ? "decision-provider-unavailable" : "invalid-decision", message(error), error instanceof AgentDecisionUnavailableError || /^大模型请求失败：HTTP (429|502|503|504)$/.test(message(error)));
          checkpoint.failure!.phase = "decision";
          await persist();
          break;
        }
        checkpoint.usage.steps += 1;
        checkpoint.decisions.push({ step: checkpoint.usage.steps, decidedAt: this.now(), decision });
        checkpoint = await this.applyDecision(checkpoint, decision, persist);
      }
      return structuredClone(checkpoint);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      this.#controllers.delete(runId);
    }
  }

  private async applyDecision(
    checkpoint: AgentCheckpoint,
    decision: AgentDecision,
    persist: () => Promise<void>,
  ): Promise<AgentCheckpoint> {
    if (decision.kind === "request-input") {
      checkpoint.pendingSelection = { step: checkpoint.usage.steps, question: decision.question, options: structuredClone(decision.options) };
      checkpoint.status = "awaiting-input";
      await persist();
      return checkpoint;
    }
    if (decision.kind === "stop") {
      const stopped = fail(checkpoint, "blocked", decision.code, decision.message, false);
      await persist();
      return stopped;
    }
    if (decision.kind === "finish") {
      const evidenceIds = evidenceIdSet(checkpoint);
      const missing = decision.evidenceIds.filter((id) => !evidenceIds.has(id));
      if (missing.length || (decision.decisionStatus === "production" && decision.evidenceIds.length === 0)) {
        const blocked = fail(checkpoint, "blocked", "evidence-required", missing.length
          ? `完成决策引用了不存在的证据：${missing.join(", ")}`
          : "生产结论必须引用工具执行证据", false);
        await persist();
        return blocked;
      }
      checkpoint.status = "completed";
      checkpoint.completion = decision;
      await persist();
      return checkpoint;
    }
    const definition = this.allowedDefinitions(checkpoint).find((tool) => tool.id === decision.call.toolId);
    if (!definition) {
      const blocked = fail(checkpoint, "blocked", "tool-not-allowed", `工具 ${decision.call.toolId} 不在本次运行授权范围`, false);
      await persist();
      return blocked;
    }
    const projectResource = decision.call.resources.find((resource) => resource.kind === "project");
    const crossProjectResource = decision.call.resources.find((resource) =>
      (resource.projectId && resource.projectId !== checkpoint.projectId)
      || (resource.kind === "project" && resource.id !== checkpoint.projectId),
    );
    if (!projectResource || crossProjectResource) {
      const blocked = fail(checkpoint, "blocked", "project-scope", projectResource ? "工具资源不能跨项目访问" : "工具调用必须声明当前项目资源", false);
      await persist();
      return blocked;
    }
    const fingerprint = this.dependencies.tools.fingerprint(decision.call);
    if (checkpoint.seenToolFingerprints.includes(fingerprint)) {
      const blocked = fail(checkpoint, "blocked", "duplicate-tool-call", `已阻断无进展的重复工具调用：${decision.call.toolId}`, false);
      await persist();
      return blocked;
    }
    checkpoint.pendingTool = {
      step: checkpoint.usage.steps,
      fingerprint,
      call: structuredClone(decision.call),
      effect: definition.effect,
      state: definition.requiresApproval ? "awaiting-approval" : "ready",
    };
    if (definition.requiresApproval) checkpoint.status = "awaiting-approval";
    await persist();
    return checkpoint;
  }

  private async executePending(
    checkpoint: AgentCheckpoint,
    signal: AbortSignal,
    persist: () => Promise<void>,
  ): Promise<AgentCheckpoint> {
    const pending = checkpoint.pendingTool!;
    if (checkpoint.usage.toolCalls >= checkpoint.budget.maxToolCalls) {
      const exhausted = fail(checkpoint, "budget-exhausted", "tool-budget", "Agent 已达到最大工具调用数", false);
      delete exhausted.pendingTool;
      await persist();
      return exhausted;
    }
    checkpoint.usage.toolCalls += 1;
    pending.state = "executing";
    const startedAt = this.now();
    await persist();
    try {
      const outcome = await raceAbort(this.dependencies.tools.execute(pending.call, {
        checkpoint: structuredClone(checkpoint),
        ...(pending.approval ? { approval: structuredClone(pending.approval) } : {}),
        signal,
      }), signal);
      if (["write", "control"].includes(pending.effect) && outcome.status === "completed" && outcome.verificationEvidence.length === 0) {
        throw new Error("写入或控制类工具没有返回执行后验证证据");
      }
      checkpoint.toolRecords.push({
        step: pending.step,
        fingerprint: pending.fingerprint,
        call: structuredClone(pending.call),
        effect: pending.effect,
        startedAt,
        completedAt: this.now(),
        outcome: structuredClone(outcome),
      });
      checkpoint.seenToolFingerprints.push(pending.fingerprint);
      delete checkpoint.pendingTool;
      if (outcome.status !== "completed") {
        checkpoint = fail(checkpoint, outcome.status === "blocked" ? "blocked" : "failed", outcome.error?.code ?? "tool-failed", outcome.error?.message ?? "工具执行失败", outcome.error?.retryable ?? true);
      }
      await persist();
      return checkpoint;
    } catch (error) {
      delete checkpoint.pendingTool;
      checkpoint = fail(checkpoint, signal.aborted ? "cancelled" : "failed", signal.aborted ? "cancelled" : "tool-failed", message(error), !signal.aborted);
      await persist();
      return checkpoint;
    }
  }

  private async abortCheckpoint(checkpoint: AgentCheckpoint, budgetTimedOut: boolean): Promise<AgentCheckpoint> {
    const latest = await this.require(checkpoint.id);
    if (latest.status === "cancelled") return latest;
    checkpoint = fail(checkpoint, budgetTimedOut ? "budget-exhausted" : "cancelled", budgetTimedOut ? "time-budget" : "cancelled", budgetTimedOut ? "Agent 已达到时间预算" : "Agent 运行已取消", false);
    delete checkpoint.pendingTool;
    await this.save(checkpoint);
    return checkpoint;
  }

  private allowedDefinitions(checkpoint: AgentCheckpoint): AgentToolDefinition[] {
    const allowed = new Set(checkpoint.allowedToolIds);
    return this.dependencies.tools.list().filter((tool) => allowed.has(tool.id)).map((tool) => structuredClone(tool));
  }

  private async require(runId: string): Promise<AgentCheckpoint> {
    const checkpoint = await this.dependencies.checkpoints.get(runId);
    if (!checkpoint) throw new AgentRunError("not-found", "Agent 运行不存在");
    return checkpoint;
  }

  private async save(checkpoint: AgentCheckpoint): Promise<void> {
    checkpoint.updatedAt = this.now();
    checkpoint.revision += 1;
    await this.dependencies.checkpoints.save(checkpoint);
  }

  private now(): string { return (this.dependencies.now?.() ?? new Date()).toISOString(); }
}

function fail(checkpoint: AgentCheckpoint, status: Extract<AgentCheckpoint["status"], "blocked" | "failed" | "cancelled" | "budget-exhausted">, code: string, messageText: string, retryable: boolean): AgentCheckpoint {
  checkpoint.status = status;
  checkpoint.failure = { code, message: messageText.slice(0, 2_000), retryable };
  return checkpoint;
}

function evidenceIdSet(checkpoint: AgentCheckpoint): Set<string> {
  return new Set(checkpoint.toolRecords.flatMap((record) => [...record.outcome.evidence, ...record.outcome.verificationEvidence].map((item) => item.id)));
}

function terminal(status: AgentCheckpoint["status"]): boolean {
  return ["completed", "blocked", "failed", "cancelled", "budget-exhausted"].includes(status);
}

function createRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function message(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => {
      signal.removeEventListener("abort", fail);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Agent 运行已取消"));
    };
    if (signal.aborted) {
      fail();
      void operation.catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", fail); resolve(value); },
      (error) => { signal.removeEventListener("abort", fail); reject(error); },
    );
  });
}
