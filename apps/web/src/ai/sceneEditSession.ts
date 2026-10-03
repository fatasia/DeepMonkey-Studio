import type { SceneCommand } from "@bim-studio/scene-sdk";
import { buildProposalPrompt, buildVerdictPrompt, parseProposal, parseVerdict, type ParsedProposal } from "./sceneEditProtocol";
import {
  readSceneState, sceneAuthorFingerprint, simulateSceneCommands, verifyExpectedFacts,
  type SceneCheck, type SceneDiff, type SceneSimulation, type SceneStateSnapshot,
} from "./sceneEditState";
import type { ViewportObservation } from "./sceneViewportObservation";

export type SceneEditMode = "plan" | "confirm" | "autonomous";
export const SCENE_EDIT_DEFAULT_CORRECTIONS = 2;
export const SCENE_EDIT_MAX_CORRECTIONS = 3;

export interface SceneEditApplyOutcome {
  status: "committed" | "rolled-back" | "rejected" | "failed";
  message?: string;
  receipt?: { id: string; baseRevision: number; finalRevision: number; commandIds: string[] };
}

/** 宿主端口:引擎读取、原子应用(单撤销单元)、取帧与撤销。runner 不接触 React/Three。 */
export interface SceneEditPort {
  unavailableReason(): string | undefined;
  readState(): SceneStateSnapshot;
  apply(commands: readonly SceneCommand[], label: string, transactionId: string): Promise<SceneEditApplyOutcome>;
  capture(): Promise<ViewportObservation | undefined>;
  undo(label: string): Promise<{ ok: boolean; message?: string }>;
}

/** 回传服务端审计链的回执:只含指纹与判定,不含命令参数/截图原文。 */
export interface SceneEditRecord {
  sessionId: string; round: number; event: "applied" | "rolled-back" | "verified" | "undone"; mode: SceneEditMode;
  planFingerprint: string; commandCount: number; receiptId?: string; checks?: { total: number; failed: number };
  viewportFingerprint?: string; verdict?: { outcome: SceneEditVerdict["outcome"]; source: SceneEditVerdict["source"] };
}
export type SceneEditRecorder = (record: SceneEditRecord) => Promise<void>;

export type SceneEditAsk = (question: string, context: unknown, signal: AbortSignal) => Promise<{ text: string; model: string }>;

export type RoundStatus =
  | "proposing" | "parse-failed" | "blocked" | "awaiting-approval" | "plan-only" | "applying" | "verifying"
  | "verified" | "rejected" | "apply-failed" | "undone" | "cancelled";

export interface SceneEditVerdict {
  outcome: "achieved" | "unachieved" | "unverified";
  reason: string;
  source: "model" | "checks";
}

export interface SceneEditRound {
  index: number;
  status: RoundStatus;
  summary: string;
  commands: SceneCommand[];
  diff?: SceneDiff;
  fingerprint?: string;
  error?: string;
  /** 本轮需要用户确认的原因(自主模式下遇到不可撤销操作时降级)。 */
  confirmReason?: string;
  applied?: {
    label: string;
    receipt?: SceneEditApplyOutcome["receipt"];
    checks: SceneCheck[];
    /** 本批是否改变了作者状态(纯相机/选择/运行时效果的批不产生撤销条目)。 */
    undoable: boolean;
    beforeShot?: ViewportObservation;
    afterShot?: ViewportObservation;
  };
  verdict?: SceneEditVerdict;
  undone?: { ok: boolean; restored: boolean; message?: string };
}

export type SceneEditSessionStatus =
  | "proposing" | "awaiting-approval" | "plan-only" | "applying" | "verifying"
  | "achieved" | "unachieved" | "unverified" | "failed" | "cancelled" | "undone";

export interface SceneEditSession {
  id: string;
  objective: string;
  mode: SceneEditMode;
  maxCorrections: number;
  status: SceneEditSessionStatus;
  rounds: SceneEditRound[];
  error?: string;
  model?: string;
  /** 审计回执落账计数(失败不阻断改动,但如实呈现)。 */
  audit?: { recorded: number; failed: number };
}

interface InternalRound { round: SceneEditRound; before: SceneStateSnapshot; sim?: SceneSimulation }

const fnv = (text: string) => { let hash = 0x811c9dc5; for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0; return hash.toString(16).padStart(8, "0"); };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/**
 * 计划→执行→验证状态机。plan:只出计划(可由用户再确认应用);confirm:每轮应用前需确认;
 * autonomous:自动应用并在轮次上限内自动修正。修正轮次上限是硬边界,防止失控。
 */
export class SceneEditRunner {
  private state: SceneEditSession;
  private internals: InternalRound[] = [];
  private readonly listeners = new Set<() => void>();
  private abort = new AbortController();
  private busy = false;
  /** 修正轮次已用数;与 rounds.length-1 一致,单独记录以便测试断言上限。 */
  private corrections = 0;

  constructor(
    private readonly port: SceneEditPort,
    private readonly ask: SceneEditAsk,
    input: { id: string; objective: string; mode: SceneEditMode; maxCorrections?: number },
    private readonly recorder?: SceneEditRecorder,
  ) {
    const max = Math.max(0, Math.min(SCENE_EDIT_MAX_CORRECTIONS, Math.floor(input.maxCorrections ?? SCENE_EDIT_DEFAULT_CORRECTIONS)));
    this.state = { id: input.id, objective: input.objective, mode: input.mode, maxCorrections: max, status: "proposing", rounds: [] };
  }

  getState = (): SceneEditSession => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private record(entry: InternalRound, event: SceneEditRecord["event"], extra: Partial<SceneEditRecord> = {}) {
    if (!this.recorder) return;
    const { round } = entry;
    const payload: SceneEditRecord = { sessionId: this.state.id, round: round.index, event, mode: this.state.mode, planFingerprint: round.fingerprint ?? "00000000", commandCount: round.commands.length, ...extra };
    void this.recorder(payload).then(
      () => this.emit({ audit: { recorded: (this.state.audit?.recorded ?? 0) + 1, failed: this.state.audit?.failed ?? 0 } }),
      () => this.emit({ audit: { recorded: this.state.audit?.recorded ?? 0, failed: (this.state.audit?.failed ?? 0) + 1 } }),
    );
  }

  private emit(patch: Partial<SceneEditSession> = {}) {
    this.state = { ...this.state, ...patch, rounds: this.internals.map(item => item.round) };
    this.listeners.forEach(listener => listener());
  }
  private patchRound(entry: InternalRound, patch: Partial<SceneEditRound>, session: Partial<SceneEditSession> = {}) {
    entry.round = { ...entry.round, ...patch };
    this.emit(session);
  }

  async start(): Promise<void> {
    if (this.busy || this.internals.length) return;
    this.busy = true;
    try { await this.propose(undefined); } finally { this.busy = false; }
  }

  async approve(): Promise<void> {
    const entry = this.internals.at(-1);
    if (this.busy || !entry || !["awaiting-approval", "plan-only"].includes(entry.round.status)) return;
    this.busy = true;
    try { await this.applyRound(entry); } finally { this.busy = false; }
  }

  reject(): void {
    const entry = this.internals.at(-1);
    if (this.busy || !entry || !["awaiting-approval", "plan-only"].includes(entry.round.status)) return;
    this.patchRound(entry, { status: "rejected" }, { status: this.internals.some(item => item.round.applied && !item.round.undone) ? "unachieved" : "cancelled" });
  }

  cancel(): void {
    this.abort.abort();
    const entry = this.internals.at(-1);
    if (entry && ["proposing", "verifying"].includes(entry.round.status)) {
      this.patchRound(entry, { status: entry.round.applied ? "verified" : "cancelled", ...(entry.round.applied ? { verdict: { outcome: "unverified", reason: "验证被取消", source: "checks" } } : {}) }, { status: entry.round.applied ? "unverified" : "cancelled" });
    }
  }

  /** 倒序撤销本会话已应用的各轮(每轮一个撤销单元);最终以作者状态指纹校验还原。 */
  async undo(): Promise<void> {
    if (this.busy) return;
    const applied = this.internals.filter(item => item.round.applied?.undoable && !item.round.undone);
    if (!applied.length) return;
    this.busy = true;
    try {
      for (const entry of [...applied].reverse()) {
        const result = await this.port.undo(entry.round.applied!.label);
        if (!result.ok) { this.patchRound(entry, { undone: { ok: false, restored: false, ...(result.message ? { message: result.message } : {}) } }, { error: result.message ?? "撤销失败" }); return; }
        const restored = sceneAuthorFingerprint(this.port.readState()) === sceneAuthorFingerprint(entry.before);
        this.record(entry, "undone");
        this.patchRound(entry, { status: "undone", undone: { ok: true, restored, ...(restored ? {} : { message: "已撤销,但作者状态与应用前存在差异(可能仍在加载)" }) } });
      }
      const { error: _cleared, ...rest } = this.state;
      this.state = rest;
      this.emit({ status: "undone" });
    } finally { this.busy = false; }
  }

  private async propose(correction: { summary: string; reason: string; failedChecks: string[] } | undefined): Promise<void> {
    const index = this.internals.length + 1;
    const before = this.port.readState();
    const entry: InternalRound = { round: { index, status: "proposing", summary: "", commands: [] }, before };
    this.internals.push(entry);
    this.emit({ status: "proposing" });
    try {
      const prompt = buildProposalPrompt({ objective: this.state.objective, state: before, ...(correction ? { correction } : {}) });
      const reply = await this.ask(prompt.question, prompt.context, this.abort.signal);
      if (this.abort.signal.aborted) return;
      this.emit({ model: reply.model });
      await this.accept(entry, parseProposal(reply.text, before.sceneId, `r${index}-`));
    } catch (reason) {
      if (this.abort.signal.aborted) return;
      this.patchRound(entry, { status: "parse-failed", error: message(reason) }, { status: "failed", error: `模型请求失败:${message(reason)}` });
    }
  }

  /** 解析结果 → 仿真差异 → 按执行方式分流。 */
  private async accept(entry: InternalRound, parsed: ParsedProposal): Promise<void> {
    if (!parsed.ok) return this.patchRound(entry, { status: "parse-failed", error: parsed.error }, { status: "failed", error: parsed.error });
    if (!parsed.commands.length) return this.patchRound(entry, { status: "blocked", summary: parsed.summary, error: `模型未提出可执行改动:${parsed.summary}` }, { status: "failed", error: `模型未提出可执行改动:${parsed.summary}` });
    const sim = simulateSceneCommands(parsed.commands, entry.before);
    entry.sim = sim;
    const base = { summary: parsed.summary, commands: parsed.commands, diff: sim.diff, fingerprint: fnv(JSON.stringify(parsed.commands)) };
    if (sim.diff.blockers.length) {
      const error = sim.diff.blockers.join(";");
      return this.patchRound(entry, { ...base, status: "blocked", error }, { status: "failed", error });
    }
    const irreversible = sim.diff.irreversibleCount > 0;
    if (this.state.mode === "plan") return this.patchRound(entry, { ...base, status: "plan-only" }, { status: "plan-only" });
    if (this.state.mode === "confirm" || irreversible) {
      return this.patchRound(entry, { ...base, status: "awaiting-approval", ...(this.state.mode === "autonomous" ? { confirmReason: "含不可撤销的运行时效果,自主执行下仍需确认" } : {}) }, { status: "awaiting-approval" });
    }
    this.patchRound(entry, { ...base, status: "applying" }, { status: "applying" });
    await this.applyRound(entry);
  }

  private async applyRound(entry: InternalRound): Promise<void> {
    const { round } = entry;
    const blocked = this.port.unavailableReason();
    if (blocked) return this.patchRound(entry, { status: "apply-failed", error: blocked }, { status: "failed", error: blocked });
    const current = this.port.readState();
    // 审阅期间场景被他人/用户改动:差异里的"前值"已失效,拒绝应用而不是悄悄覆盖。
    if (sceneAuthorFingerprint(current) !== sceneAuthorFingerprint(entry.before)) {
      const error = "场景在审阅期间已变化,差异已失效,请重新生成方案";
      return this.patchRound(entry, { status: "apply-failed", error }, { status: "failed", error });
    }
    this.patchRound(entry, { status: "applying" }, { status: "applying" });
    const label = `AI 改动 ${this.state.id.slice(-4)}·${round.index} ${round.summary.slice(0, 16)}`.trim();
    const beforeShot = await this.port.capture();
    let outcome: SceneEditApplyOutcome;
    try { outcome = await this.port.apply(round.commands, label, `${this.state.id}-r${round.index}`); }
    catch (reason) { outcome = { status: "failed", message: message(reason) }; }
    if (outcome.status !== "committed") {
      if (outcome.status === "rolled-back") this.record(entry, "rolled-back");
      const error = outcome.status === "rolled-back" ? `应用失败,整批已回滚:${outcome.message ?? ""}` : `未应用:${outcome.message ?? outcome.status}`;
      return this.patchRound(entry, { status: "apply-failed", error }, { status: "failed", error });
    }
    const after = this.port.readState();
    const checks = verifyExpectedFacts(entry.sim!.expected, after, entry.sim!.after);
    const afterShot = await this.port.capture();
    this.patchRound(entry, { status: "verifying", applied: { label, ...(outcome.receipt ? { receipt: outcome.receipt } : {}), checks, undoable: sceneAuthorFingerprint(after) !== sceneAuthorFingerprint(entry.before), ...(beforeShot ? { beforeShot } : {}), ...(afterShot ? { afterShot } : {}) } }, { status: "verifying" });
    this.record(entry, "applied", { ...(outcome.receipt ? { receiptId: outcome.receipt.id } : {}), checks: { total: checks.length, failed: checks.filter(check => !check.ok).length }, ...(afterShot ? { viewportFingerprint: afterShot.metrics.fingerprint } : {}) });
    await this.verify(entry, after, checks, afterShot);
  }

  private async verify(entry: InternalRound, after: SceneStateSnapshot, checks: SceneCheck[], shot: ViewportObservation | undefined) {
    const failed = checks.filter(check => !check.ok);
    const correctionsLeft = this.state.maxCorrections - this.corrections;
    let verdict: SceneEditVerdict;
    let correction: ParsedProposal | undefined;
    try {
      const prompt = buildVerdictPrompt({
        objective: this.state.objective, summary: entry.round.summary, diff: entry.round.diff!, checks, state: after,
        touchedIds: entry.round.diff!.entries.flatMap(item => item.subject.match(/\(([^)]+)\)$/)?.[1] ?? []),
        ...(shot ? { viewport: shot.metrics } : {}), correctionsLeft,
      });
      const reply = await this.ask(prompt.question, prompt.context, this.abort.signal);
      if (this.abort.signal.aborted) return;
      const parsed = parseVerdict(reply.text, after.sceneId, `r${entry.round.index + 1}-`);
      if (!parsed) throw new Error("验收输出不是合法 JSON");
      const achieved = parsed.achieved && failed.length === 0;
      verdict = {
        outcome: achieved ? "achieved" : "unachieved", source: "model",
        reason: failed.length && parsed.achieved ? `核对 ${failed.length} 项未生效(${failed.map(item => item.label).join("、")}),与模型判定不一致,按未达成处理` : parsed.reason,
      };
      correction = parsed.correction;
    } catch (reason) {
      if (this.abort.signal.aborted) return;
      verdict = failed.length
        ? { outcome: "unachieved", source: "checks", reason: `核对 ${failed.length} 项未生效:${failed.map(item => item.label).join("、")}` }
        : { outcome: "unverified", source: "checks", reason: `模型自检不可用(${message(reason)});确定性核对 ${checks.length} 项全部通过` };
    }
    this.patchRound(entry, { status: "verified", verdict });
    this.record(entry, "verified", { verdict: { outcome: verdict.outcome, source: verdict.source }, checks: { total: checks.length, failed: failed.length } });
    if (verdict.outcome !== "unachieved") return this.emit({ status: verdict.outcome });
    const usable = correction?.ok && correction.commands.length > 0 && correctionsLeft > 0;
    if (!usable) {
      const why = correctionsLeft <= 0 ? `已达修正轮次上限(${this.state.maxCorrections})` : correction && !correction.ok ? `修正方案无效:${correction.error}` : "模型未给出修正方案";
      return this.emit({ status: "unachieved", error: why });
    }
    this.corrections += 1;
    const next: InternalRound = { round: { index: this.internals.length + 1, status: "proposing", summary: "", commands: [] }, before: this.port.readState() };
    this.internals.push(next);
    await this.accept(next, correction!);
  }
}
