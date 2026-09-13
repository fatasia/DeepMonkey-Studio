import { type BackendSwitchCoordinator, type BackendSwitchResult,
  type SwitchableBackend } from "./backendSwitch.js";

export interface BackendPreferenceStore {
  load(): Promise<unknown>;
  save(backendId: string): Promise<void>;
}

export interface BackendPreferenceSnapshot {
  readonly activeId: string;
  readonly desiredId: string;
  readonly persistedId: string;
  readonly phase: "idle" | "switching" | "fallback" | "error";
  readonly error?: string;
}

export interface BackendPreferenceResult {
  readonly status: "applied" | "unchanged" | "fallback" | "failed"
    | "persistence-failed" | "superseded";
  readonly snapshot: BackendPreferenceSnapshot;
  readonly switchResult?: BackendSwitchResult;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const validId = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/.test(value);

/**
 * 设置层只持有引擎选择，不复制作者状态。切换成功后才排队持久化；并发选择的
 * 写入严格保序，启动失败时保留当前可用后端并显式呈现 fallback。
 */
export class BackendPreferenceController<TState, TBackend extends SwitchableBackend> {
  private desiredId: string;
  private persistedId: string;
  private phase: BackendPreferenceSnapshot["phase"] = "idle";
  private error: string | undefined;
  private generation = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly targets: ReadonlySet<string>;

  constructor(
    private readonly coordinator: BackendSwitchCoordinator<TState, TBackend>,
    private readonly store: BackendPreferenceStore,
    targetIds: readonly string[],
  ) {
    if (targetIds.length < 2 || targetIds.length > 16
      || targetIds.some(id => !validId(id)) || new Set(targetIds).size !== targetIds.length
      || !targetIds.includes(coordinator.active.id)) {
      throw new Error("Backend preference targets must be unique valid ids and include the active backend.");
    }
    this.targets = new Set(targetIds);
    this.desiredId = coordinator.active.id;
    this.persistedId = coordinator.active.id;
  }

  get snapshot(): BackendPreferenceSnapshot {
    return Object.freeze({
      activeId: this.coordinator.active.id,
      desiredId: this.desiredId,
      persistedId: this.persistedId,
      phase: this.phase,
      ...(this.error === undefined ? {} : { error: this.error }),
    });
  }

  async initialize(): Promise<BackendPreferenceResult> {
    const generation = ++this.generation;
    let stored: unknown;
    try { stored = await this.store.load(); }
    catch (error) {
      if (generation !== this.generation) return { status: "superseded", snapshot: this.snapshot };
      return this.fallback(`Renderer preference could not be loaded: ${message(error)}`);
    }
    if (generation !== this.generation) return { status: "superseded", snapshot: this.snapshot };
    if (stored === null || stored === undefined) return { status: "unchanged", snapshot: this.snapshot };
    if (!validId(stored) || !this.targets.has(stored)) {
      return this.fallback("Stored renderer preference is invalid or unavailable.");
    }
    this.persistedId = stored;
    return this.apply(stored, true);
  }

  async select(targetId: string): Promise<BackendPreferenceResult> {
    if (!validId(targetId) || !this.targets.has(targetId)) {
      throw new Error(`Unknown renderer backend: ${targetId}`);
    }
    return this.apply(targetId, false);
  }

  private async apply(targetId: string, startup: boolean): Promise<BackendPreferenceResult> {
    const generation = ++this.generation;
    this.desiredId = targetId;
    this.phase = "switching";
    this.error = undefined;
    const switchResult = await this.coordinator.switchTo(targetId);
    if (generation !== this.generation) return this.result("superseded", switchResult);
    if (switchResult.status !== "switched" && switchResult.status !== "unchanged") {
      this.phase = startup ? "fallback" : "error";
      this.error = switchResult.error ?? `Renderer switch ${switchResult.status}.`;
      return this.result(startup ? "fallback" : "failed", switchResult);
    }
    if (switchResult.activeId !== targetId) {
      this.phase = "error";
      this.error = "Renderer switch reported success without activating the requested backend.";
      return this.result("failed", switchResult);
    }
    if (this.persistedId !== targetId) {
      try { await this.persist(targetId); }
      catch (error) {
        if (generation !== this.generation) return this.result("superseded", switchResult);
        this.phase = "error";
        this.error = `Renderer preference could not be saved: ${message(error)}`;
        return this.result("persistence-failed", switchResult);
      }
    }
    if (generation !== this.generation) return this.result("superseded", switchResult);
    this.phase = "idle";
    this.error = undefined;
    return this.result(switchResult.status === "unchanged" ? "unchanged" : "applied", switchResult);
  }

  private async persist(targetId: string): Promise<void> {
    const operation = this.saveQueue.catch(() => {}).then(() => this.store.save(targetId));
    this.saveQueue = operation;
    await operation;
    this.persistedId = targetId;
  }

  private fallback(error: string): BackendPreferenceResult {
    this.desiredId = this.coordinator.active.id;
    this.phase = "fallback";
    this.error = error;
    return { status: "fallback", snapshot: this.snapshot };
  }

  private result(status: BackendPreferenceResult["status"],
    switchResult: BackendSwitchResult): BackendPreferenceResult {
    return { status, switchResult, snapshot: this.snapshot };
  }
}
