/** 后端独占渲染资源；dispose 只释放/提交退役，不得销毁共享场景或脚本。 */
export interface SwitchableBackend {
  readonly id: string;
  dispose(): void;
}

export interface BackendSwitchResult {
  readonly status: "switched" | "unchanged" | "cancelled" | "failed";
  readonly activeId: string;
  readonly error?: string;
  readonly cleanupErrors: readonly string[];
}

export type BackendStateRevision = number | string;

export interface BackendRevisionBarrier<TState, TBackend extends SwitchableBackend> {
  /** 读取唯一作者状态的当前 revision；不得推进脚本或复制状态。 */
  read(state: TState): BackendStateRevision;
  /** 把候选后端追平到指定 revision，并返回它实际接受的 revision。 */
  catchUp(backend: TBackend, state: TState, revision: BackendStateRevision,
    signal: AbortSignal): Promise<BackendStateRevision>;
}

export interface BackendPreparation<TState, TBackend extends SwitchableBackend> {
  readonly state: TState;
  /** 必须在能力检查、资源预热、首帧准备完成后返回；失败时自行释放未返回的资源。 */
  prepare(targetId: string, state: TState, signal: AbortSignal): Promise<TBackend>;
  /** 在宿主帧边界调用 publish；此前旧后端持续服务。不得缓存或重复调用 publish。 */
  atFrameBoundary(publish: () => void, signal: AbortSignal): Promise<void>;
  /**
   * 在同一个帧边界同步交接可见表面。实现必须先完成全部校验，并在抛错时恢复旧表面；
   * 此钩子成功后协调器才会改变 active 并退役旧后端。
   */
  publishSurface?(candidate: TBackend, previous: TBackend): void;
  /** 配置后，作者状态在预热期间变化会重新追平，旧 revision 不能发布。 */
  readonly revisionBarrier?: BackendRevisionBarrier<TState, TBackend>;
  readonly timeoutMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validRevision(value: unknown): value is BackendStateRevision {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** 只交接渲染资源所有权，共享状态始终是同一个引用，不重启脚本或仿真。 */
export class BackendSwitchCoordinator<TState, TBackend extends SwitchableBackend> {
  private activeBackend: TBackend;
  private pending: AbortController | undefined;
  private closed = false;
  private readonly released = new WeakSet<TBackend>();
  private readonly cleanupErrors: string[] = [];
  private readonly timeoutMs: number;

  constructor(initial: TBackend, private readonly preparation: BackendPreparation<TState, TBackend>) {
    this.activeBackend = initial;
    this.timeoutMs = preparation.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Backend preparation timeout must be positive and finite.");
    }
  }

  get active(): TBackend { return this.activeBackend; }
  get state(): TState { return this.preparation.state; }
  get diagnostics(): readonly string[] { return [...this.cleanupErrors]; }

  async switchTo(targetId: string): Promise<BackendSwitchResult> {
    if (this.closed) return this.result("failed", "Backend switch coordinator is disposed.");
    this.pending?.abort();
    this.pending = undefined;
    if (targetId === this.activeBackend.id) return this.result("unchanged");
    const controller = new AbortController();
    const { signal } = controller;
    this.pending = controller;
    let timedOut = false;
    let published = false;
    let candidate: TBackend | undefined;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let onAbort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(timedOut ? "Backend preparation timed out." : "Backend switch cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const preparing = Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("Backend switch cancelled.");
        return this.preparation.prepare(targetId, this.state, signal);
      }).then((backend) => {
        // prepare 忽略取消时，迟到资源仍须退役，不能泄漏或抢回当前后端。
        if (signal.aborted) this.release(backend);
        return backend;
      });
      candidate = await Promise.race([preparing, interrupted]);
      if (candidate.id !== targetId || candidate === this.activeBackend || this.released.has(candidate)) {
        throw new Error("Prepared backend identity does not match the requested target.");
      }
      const barrier = this.preparation.revisionBarrier;
      for (;;) {
        let synchronizedRevision: BackendStateRevision | undefined;
        if (barrier) {
          const expected = barrier.read(this.state);
          if (!validRevision(expected)) throw new Error("Backend author revision is invalid.");
          synchronizedRevision = await Promise.race([
            barrier.catchUp(candidate, this.state, expected, signal), interrupted,
          ]);
          if (!validRevision(synchronizedRevision) || synchronizedRevision !== expected) {
            throw new Error("Prepared backend did not accept the requested author revision.");
          }
        }
        let completePublication!: () => void;
        const committed = new Promise<"published">((resolve) => {
          completePublication = () => resolve("published");
        });
        let callbackCalled = false;
        let boundaryOpen = true;
        let stale = false;
        const boundary = Promise.resolve().then(() => this.preparation.atFrameBoundary(() => {
          if (!boundaryOpen || callbackCalled) return;
          callbackCalled = true;
          if (signal.aborted || published || this.pending !== controller || this.closed) return;
          if (barrier) {
            const current = barrier.read(this.state);
            if (!validRevision(current)) throw new Error("Backend author revision is invalid.");
            if (current !== synchronizedRevision) { stale = true; return; }
          }
          const previous = this.activeBackend;
          this.preparation.publishSurface?.(candidate!, previous);
          this.activeBackend = candidate!;
          published = true;
          clearTimeout(timer);
          this.release(previous);
          completePublication();
        }, signal)).then(() => {
          boundaryOpen = false;
          if (!published && !stale) throw new Error("Frame boundary completed without publishing the backend.");
          return stale ? "stale" as const : "completed" as const;
        }).catch((error: unknown) => {
          boundaryOpen = false;
          if (published) this.cleanupErrors.push(`frame-boundary: ${errorText(error)}`);
          throw error;
        });
        const outcome = await Promise.race([committed, boundary, interrupted]);
        if (outcome === "published" || published) break;
        if (outcome !== "stale") throw new Error("Frame boundary completed without publishing the backend.");
      }
      if (!published) throw new Error("Frame boundary completed without publishing the backend.");
      return this.result("switched");
    } catch (error) {
      if (candidate && !published) this.release(candidate);
      if (published) return this.result("switched");
      return this.result(signal.aborted && !timedOut ? "cancelled" : "failed", errorText(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (this.pending === controller) this.pending = undefined;
      // 使任何被宿主延迟调用的 publish 失效。
      controller.abort();
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending?.abort();
    this.pending = undefined;
    this.release(this.activeBackend, true);
  }

  private release(backend: TBackend, allowActive = false): void {
    if (this.released.has(backend) || (!allowActive && backend === this.activeBackend)) return;
    this.released.add(backend);
    try { backend.dispose(); }
    catch (error) { this.cleanupErrors.push(`${backend.id}: ${errorText(error)}`); }
  }

  private result(status: BackendSwitchResult["status"], error?: string): BackendSwitchResult {
    return {
      status, activeId: this.activeBackend.id, cleanupErrors: this.diagnostics,
      ...(error === undefined ? {} : { error }),
    };
  }
}
