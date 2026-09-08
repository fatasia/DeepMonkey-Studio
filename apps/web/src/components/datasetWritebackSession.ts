import type { DataWritebackConfig, DataWritebackIssue, DataWritebackRequest, DataWritebackSnapshot } from "@bim-studio/contracts";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { createWritebackDraft, prepareWritebackDraft } from "./dashboardWritebackDraft";
import type { CachedWritebackDraft } from "./datasetWritebackDraftCache";

export interface WritebackTransport {
  read(id: string, signal: AbortSignal): Promise<DataWritebackSnapshot>;
  write(id: string, changes: DataWritebackRequest, signal: AbortSignal): Promise<DataWritebackSnapshot>;
}
export interface WritebackState {
  recordId: string;
  phase: "idle" | "loading" | "editing" | "confirming" | "writing";
  draft: Record<string, string>;
  baseline?: DataWritebackSnapshot;
  remote?: DataWritebackSnapshot;
  needsReconcile: boolean;
  issues: DataWritebackIssue[];
  error: string;
  saved: boolean;
}

/** 一个挂载表单拥有一个会话。取消只停止客户端等待，不把写入中断解释成服务端回滚。 */
export class DatasetWritebackSession {
  private state: WritebackState = { recordId: "", phase: "idle", draft: {}, needsReconcile: false, issues: [], error: "", saved: false };
  private listeners = new Set<() => void>();
  private request: AbortController | undefined;
  private generation = 0;
  constructor(readonly config: DataWritebackConfig, private readonly transport: WritebackTransport, restored?: CachedWritebackDraft) {
    if (restored) this.state = { ...this.state, ...restored, phase: "editing", needsReconcile: true, error: "已恢复未提交修改，请重新读取核对当前记录。" };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<WritebackState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  dispose() { this.generation++; this.request?.abort(); this.listeners.clear(); }
  edit(key: string, value: string) {
    if (this.state.phase !== "editing" || !this.config.fields.some(field => field.key === key)) return;
    this.update({ draft: { ...this.state.draft, [key]: value }, issues: [], saved: false });
  }
  async read(recordId: string, reconcile = false) {
    if (this.state.phase === "writing" || this.state.phase === "loading") return;
    if (!/^[\p{L}\p{N}_-]{1,128}$/u.test(recordId)) {
      this.update({ error: "记录编号仅支持文字、数字、下划线和短横线（最多 128 字符）" }); return;
    }
    const generation = ++this.generation;
    this.request?.abort(); this.request = new AbortController();
    this.update({ phase: "loading", error: "", saved: false });
    try {
      const snapshot = await this.transport.read(recordId, this.request.signal);
      if (generation !== this.generation) return;
      if (reconcile && this.state.baseline && recordId === this.state.recordId) {
        this.update({ remote: snapshot, phase: "editing", needsReconcile: true });
      } else {
        this.state = { recordId, phase: "editing", baseline: snapshot, draft: createWritebackDraft(this.config, snapshot), needsReconcile: false, issues: [], error: "", saved: false };
        this.update({});
      }
    } catch (reason) {
      if (generation === this.generation) this.update({ phase: this.state.baseline ? "editing" : "idle", error: String(reason instanceof Error ? reason.message : reason) });
    }
  }
  review() {
    if (this.state.phase !== "editing" || this.state.needsReconcile || !this.state.baseline) return;
    const { issues } = prepareWritebackDraft(this.config, this.state.draft);
    this.update({ issues, phase: issues.length ? "editing" : "confirming", error: "", saved: false });
  }
  cancelReview() { if (this.state.phase === "confirming") this.update({ phase: "editing" }); }
  async submit() {
    const { baseline, recordId } = this.state;
    if (this.state.phase !== "confirming" || !baseline || this.state.needsReconcile) return;
    const { values, issues } = prepareWritebackDraft(this.config, this.state.draft);
    if (issues.length) { this.update({ phase: "editing", issues }); return; }
    const generation = ++this.generation;
    this.request = new AbortController();
    this.update({ phase: "writing", error: "", saved: false });
    try {
      const snapshot = await this.transport.write(recordId, { expectedVersion: baseline.version, values }, this.request.signal);
      if (generation !== this.generation) return;
      this.update({ baseline: snapshot, draft: createWritebackDraft(this.config, snapshot), phase: "editing", needsReconcile: false, saved: true });
    } catch (reason) {
      if (generation !== this.generation) return;
      const failure = reason instanceof ServerRequestError ? reason : undefined;
      const body = failure?.body as { outcome?: string; issues?: DataWritebackIssue[] } | undefined;
      const rejectedBeforeWrite = failure && body?.outcome === undefined && [401, 403, 404, 413].includes(failure.status);
      const uncertain = !failure || (body?.outcome !== "not-written" && !rejectedBeforeWrite);
      this.update({ phase: "editing", needsReconcile: failure?.status === 409 || uncertain,
        error: uncertain ? "写入结果未确认，请重新读取核对，勿重复提交。" : failure!.message,
        issues: Array.isArray(body?.issues) ? body.issues : [] });
    }
  }
  resolveRemote(keepEdits: boolean) {
    const { baseline, remote, draft } = this.state;
    if (!remote || !baseline || this.state.phase !== "editing") return;
    const next = createWritebackDraft(this.config, remote);
    if (keepEdits) {
      const before = createWritebackDraft(this.config, baseline);
      // 只保留实际编辑字段；其他人修改的未编辑字段必须随新版本前移。
      for (const field of this.config.fields) if (draft[field.key] !== before[field.key]) next[field.key] = draft[field.key]!;
    }
    const { remote: _remote, ...rest } = this.state;
    this.state = { ...rest, baseline: remote, draft: next, needsReconcile: false, error: "", issues: [], saved: false };
    this.update({});
  }
}
