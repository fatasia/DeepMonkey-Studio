import { CascadedShadowResources, type CascadedShadowResourceOptions } from "./cascadedShadowResources.js";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";

/** Exact author shadow replacements are validated off-frame and published at a frame boundary. */
export class PbrShadowState {
  private active: CascadedShadowResources;
  private pending: CascadedShadowResources | undefined;
  private pendingUnlink: (() => void) | undefined;
  private inFlight: { cancel(): void } | undefined;
  private revision = 0;
  private disposed = false;
  private readonly retired = new Set<CascadedShadowResources>();
  private readonly options: CascadedShadowResourceOptions;
  /** M2 光追阴影:group(2) binding(3) mask 视图(RT 管线变体才非 undefined);
   *  stage() 的新候选必须携带同一视图。 */
  private rayTracedMaskView: GPUTextureView | undefined;

  constructor(private readonly session: DeviceSession, private readonly pipelines: Pipelines,
    options: CascadedShadowResourceOptions = {}, rayTracedShadowMaskView?: GPUTextureView) {
    this.options = { ...options, ...(options.exactProfile ? { exactProfile: { ...options.exactProfile } } : {}) };
    this.rayTracedMaskView = rayTracedShadowMaskView;
    this.active = new CascadedShadowResources(session, pipelines, this.maskedOptions());
  }

  private maskedOptions(overrides?: Partial<CascadedShadowResourceOptions>): CascadedShadowResourceOptions {
    const base = this.rayTracedMaskView === undefined ? this.options
      : { ...this.options, rayTracedShadowMaskView: this.rayTracedMaskView };
    return overrides === undefined ? base : { ...base, ...overrides };
  }

  /** M2 光追阴影:resize 后换 mask 视图(重建活动级联资源的 group(2) bind group);
   *  非 RT 管线变体传 view 会在 CascadedShadowResources 侧 fail-closed 抛错。 */
  setRayTracedShadowMaskView(view: GPUTextureView): void {
    if (this.disposed) throw new Error("PBR shadow state is unavailable.");
    this.rayTracedMaskView = view;
    this.active.replaceRayTracedShadowMaskView(view);
  }

  get current(): CascadedShadowResources { return this.active; }

  async stage(mapSize: number, signal?: AbortSignal): Promise<"staged" | "superseded"> {
    if (this.disposed || this.session.state !== "ready") throw new Error("PBR shadow state is unavailable.");
    if (this.options.exactProfile?.cascadeCount !== 1) throw new Error("Shadow map resizing requires an exact one-layer profile.");
    if (signal?.aborted) {
      const error = new Error("Shadow preparation cancelled"); error.name = "AbortError"; throw error;
    }
    const revision = ++this.revision;
    this.inFlight?.cancel();
    this.clearPending();
    let candidate: CascadedShadowResources | undefined;
    let unlink = () => {};
    let cancelValidation!: () => void;
    const cancelled = new Promise<undefined>(resolve => { cancelValidation = () => resolve(undefined); });
    const request = { cancel: () => { candidate?.dispose(); unlink(); cancelValidation(); } };
    this.inFlight = request;
    const device = this.session.device;
    device.pushErrorScope("validation");
    let scopeOpen = true;
    try {
      candidate = new CascadedShadowResources(this.session, this.pipelines, this.maskedOptions({
        ...(this.options.exactProfile ? { exactProfile: { ...this.options.exactProfile, shadowMapSize: mapSize } } : {}),
      }));
      if (signal) {
        signal.addEventListener("abort", request.cancel, { once: true });
        unlink = () => signal.removeEventListener("abort", request.cancel);
      }
      const validation = device.popErrorScope(); scopeOpen = false;
      const error = await Promise.race([validation, cancelled]);
      if (error === undefined || this.disposed || revision !== this.revision || signal?.aborted || this.session.state !== "ready") {
        candidate.dispose(); return "superseded";
      }
      if (error) throw new Error(`Shadow resource validation failed: ${error.message}`);
      this.pending = candidate;
      if (signal) {
        const cancel = (): void => { if (this.pending === candidate) this.clearPending(); };
        signal.addEventListener("abort", cancel, { once: true });
        this.pendingUnlink = () => signal.removeEventListener("abort", cancel);
      }
      return "staged";
    } catch (error) {
      candidate?.dispose();
      if (this.disposed || revision !== this.revision || signal?.aborted) return "superseded";
      throw error;
    } finally {
      unlink();
      if (this.inFlight === request) this.inFlight = undefined;
      if (scopeOpen) await device.popErrorScope();
    }
  }

  publish(mapSize: number | undefined, activate: (candidate: CascadedShadowResources) => void): boolean {
    if (this.disposed || !this.pending || mapSize !== this.pending.selection.profile.options.shadowMapSize) return false;
    const candidate = this.pending, revision = this.revision;
    this.pending = undefined; this.pendingUnlink?.(); this.pendingUnlink = undefined;
    try { activate(candidate); }
    catch (error) { candidate.dispose(); throw error; }
    if (this.disposed || revision !== this.revision) { candidate.dispose(); return false; }
    const previous = this.active;
    this.active = candidate;
    this.retired.add(previous);
    // Work already submitted with the previous map must finish before it is destroyed.
    const release = (): void => { if (this.retired.delete(previous)) previous.dispose(); };
    try { void this.session.device.queue.onSubmittedWorkDone().then(release, release); }
    catch { release(); }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; ++this.revision;
    this.inFlight?.cancel(); this.inFlight = undefined;
    this.clearPending(); this.active.dispose();
    for (const resource of this.retired) resource.dispose();
    this.retired.clear();
  }

  private clearPending(): void {
    this.pendingUnlink?.(); this.pendingUnlink = undefined;
    this.pending?.dispose(); this.pending = undefined;
  }
}
