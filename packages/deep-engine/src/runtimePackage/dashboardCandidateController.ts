import { RuntimeResourcePrewarmExecutor } from "./resourcePrewarmExecutor.js";
import { runtimeResourcePrewarmStrategy } from "./resourcePrewarmPlan.js";
import type { RuntimeResourcePrewarmCandidate } from "./resourcePrewarmTypes.js";
import { buildDashboardCandidateState, type DashboardCandidateState } from "./dashboardCandidateState.js";
import type { DashboardCandidateHost, DashboardCandidateIdentity, DashboardCandidateOptions,
  DashboardCandidateResult, DashboardPageCandidate, DashboardResourceLoader } from "./dashboardCandidateTypes.js";
import { prepareDashboardCandidateRequest } from "./dashboardCandidateRequest.js";

interface Owner<TLoaded, TResource, TFrame> {
  readonly executor: RuntimeResourcePrewarmExecutor<TLoaded, TResource>;
  readonly cleanupErrors: string[];
  hasFrame: boolean;
  frame?: TFrame;
}
interface Pending { readonly generation: number; readonly controller: AbortController }

/** At most one active and one building candidate, including work that ignores cancellation. */
export class DashboardCandidateController<TLoaded, TResource, TFrame> {
  private generation = 0;
  private disposed = false;
  private committing = false;
  private pending: Pending | undefined;
  private readonly pageStates = new Map<string, DashboardCandidateState>();
  private active: { owner: Owner<TLoaded, TResource, TFrame>; state: DashboardCandidateState } | undefined;

  constructor(private readonly loader: DashboardResourceLoader<TLoaded, TResource>,
    private readonly host?: DashboardCandidateHost<TLoaded, TResource, TFrame>) {}

  get activePage(): DashboardPageCandidate | undefined { return this.active?.state.page; }

  async publish(input: unknown, requested: DashboardCandidateOptions): Promise<DashboardCandidateResult> {
    this.assertUsable();
    if (this.pending) return { status: "busy", releaseFailures: [] };
    const { value, options, page } = prepareDashboardCandidateRequest(input, requested, this.active?.state.page.identity);
    if (!this.host) return { status: "requires-host", failure: "Dashboard prepare/visible-commit host is required.", releaseFailures: [] };
    if (options.signal?.aborted) return { status: "aborted", releaseFailures: [] };
    const identity: DashboardCandidateIdentity = Object.freeze({ packageHash: value.packageHash.value,
      pageId: page.id, generation: ++this.generation, deviceEpoch: options.deviceEpoch });
    const controller = new AbortController(), pending = { generation: identity.generation, controller };
    this.pending = pending;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const releaseFailures: string[] = [];
    let resources: readonly RuntimeResourcePrewarmCandidate<TLoaded, TResource>[] | undefined;
    const cleanupErrors: string[] = [];
    const owner: Owner<TLoaded, TResource, TFrame> = { hasFrame: false, cleanupErrors,
      executor: new RuntimeResourcePrewarmExecutor<TLoaded, TResource>({
        load: (item, value, signal) => this.loader.load(item, value, signal),
        prepare: (item, loaded, signal) => this.loader.prepare(item, loaded, signal),
        release: (item, loaded, prepared) => {
          try { this.loader.release(item, loaded, prepared); }
          catch (error) { cleanupErrors.push(message(error)); throw error; }
        },
        commit: (_plan, candidates) => { resources = candidates; },
      }, runtimeResourcePrewarmStrategy) };
    let committed = false;
    try {
      let stopped = this.stopped(identity, controller);
      if (stopped) return { status: stopped, identity, releaseFailures };
      const ready = await owner.executor.publish(value, { ...options, signal: controller.signal });
      releaseFailures.push(...cleanupErrors.splice(0));
      stopped = this.stopped(identity, controller);
      if (stopped) return { status: stopped, identity, releaseFailures };
      if (ready.status !== "committed" || !resources) {
        return { status: "failed", identity, failure: ready.failure ?? "Resources were not prepared.", releaseFailures };
      }
      // This is the whole-resource barrier; no chart or page candidate is built in a resource worker.
      const prior = this.active?.state.page.identity;
      const state = buildDashboardCandidateState(value, page, identity, options,
        prior?.packageHash === identity.packageHash ? this.pageStates.get(identity.pageId) : undefined);
      owner.frame = await this.host.prepare(state.page, resources, controller.signal);
      owner.hasFrame = true;
      stopped = this.stopped(identity, controller);
      if (stopped) return { status: stopped, identity, releaseFailures };
      const previous = this.active;
      this.committing = true;
      try {
        this.host.commitVisible(owner.frame);
        if (prior?.packageHash !== identity.packageHash) this.pageStates.clear();
        this.pageStates.set(identity.pageId, state);
        this.active = { owner, state };
        committed = true;
      } finally { this.committing = false; }
      if (previous) this.release(previous.owner, releaseFailures);
      return { status: "committed", identity, releaseFailures };
    } catch (error) {
      return { status: this.stopped(identity, controller) ?? "failed", identity,
        failure: message(error), releaseFailures };
    } finally {
      if (!committed) this.release(owner, releaseFailures);
      options.signal?.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  dispose(): void {
    this.assertOutsideCommit();
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.pending?.controller.abort();
    const previous = this.active; this.active = undefined; this.pageStates.clear();
    if (previous) this.release(previous.owner, []);
    // Pending resources remain owned until load/prepare actually settles, even after abort.
  }

  private stopped(identity: DashboardCandidateIdentity, controller: AbortController):
    "superseded" | "aborted" | "device-changed" | undefined {
    if (this.disposed || this.generation !== identity.generation) return "superseded";
    if (controller.signal.aborted) return "aborted";
    try { if (this.host!.currentDeviceEpoch() !== identity.deviceEpoch) return "device-changed"; }
    catch { return "device-changed"; }
    if (this.disposed || this.generation !== identity.generation) return "superseded";
    return undefined;
  }
  private release(owner: Owner<TLoaded, TResource, TFrame>, failures: string[]): void {
    if (owner.hasFrame) {
      owner.hasFrame = false;
      try { this.host!.release(owner.frame as TFrame); } catch (error) { failures.push(message(error)); }
    }
    try { owner.executor.dispose(); } catch (error) { failures.push(message(error)); }
    failures.push(...owner.cleanupErrors.splice(0));
  }
  private assertOutsideCommit(): void {
    if (this.committing) throw new Error("Dashboard visible commit does not allow publish/dispose reentrancy.");
  }
  private assertUsable(): void {
    this.assertOutsideCommit();
    if (this.disposed) throw new Error("Dashboard candidate controller is disposed.");
  }
}

function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 512); }
