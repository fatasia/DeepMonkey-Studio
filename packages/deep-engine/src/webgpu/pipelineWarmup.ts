/**
 * C26 管线预热队列:视口首帧必需管线优先编译,非必需管线让路。
 *
 * 语义:
 * - 优先级 first-frame > background > idle;同优先级 FIFO。
 * - background 用并发上限(concurrency)限制同时压在设备上的编译数——
 *   T11 实测过无界并发与上传/首帧验证争抢设备(上传 7→509ms)的教训;
 * - idle 优先级只在调度器给出空闲窗口时启动(requestIdleCallback,
 *   环境不可用时退回 setTimeout),供宿主做跨场景/跨会话预热而不挤占渲染。
 * - pause 阻止任何任务启动(对齐 T11 的 release 门:背景变体在首帧验证
 *   通过前绝不排队);resume 按优先级放水。
 * - 单个任务失败不阻断队列其余任务;调用方拿到各自 promise 的拒绝。
 */

export type PipelineWarmupPriority = "first-frame" | "background" | "idle";

const deviceQueues = new WeakMap<object, PipelineWarmupQueue>();
/** Static and deformed variants share the device's background compilation budget. */
export function pipelineWarmupQueueForDevice(device: object): PipelineWarmupQueue {
  let queue = deviceQueues.get(device);
  if (!queue) { queue = new PipelineWarmupQueue({ concurrency: 2 }); deviceQueues.set(device, queue); }
  return queue;
}

const PRIORITY_ORDER: readonly PipelineWarmupPriority[] = ["first-frame", "background", "idle"];

export interface WarmupTask<T> {
  readonly fingerprint: string;
  readonly label: string;
  readonly priority?: PipelineWarmupPriority;
  create(): Promise<T>;
}

export type WarmupScheduler = (callback: () => void) => () => void;

export interface PipelineWarmupQueueOptions {
  /** 同时在飞的编译上限;缺省 2。首帧关键子集不应走队列(调用方自行全并发)。 */
  readonly concurrency?: number;
  /** true 时 idle 优先级经调度器让路;缺省 false(background 立即可排)。 */
  readonly idleScheduling?: boolean;
  /** 注入调度器;缺省 requestIdleCallback→setTimeout 退回链。 */
  readonly scheduler?: WarmupScheduler;
}

interface QueuedTask {
  readonly fingerprint: string;
  readonly label: string;
  readonly priority: PipelineWarmupPriority;
  readonly start: () => void;
  inFlight: boolean;
}

function defaultScheduler(callback: () => void): () => void {
  const idle = globalThis as { requestIdleCallback?: (cb: () => void) => number; setTimeout?: typeof setTimeout };
  if (typeof idle.requestIdleCallback === "function") {
    idle.requestIdleCallback(callback);
    return () => { /* requestIdleCallback 已触发路径无危害;队列语义由 idleWindowPending 兜住 */ };
  }
  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
}

export class PipelineWarmupQueue {
  private readonly queue: QueuedTask[] = [];
  private readonly concurrency: number;
  private readonly idleScheduling: boolean;
  private readonly scheduler: WarmupScheduler;
  private inFlight = 0;
  private readonly drainWaiters = new Set<() => void>();
  private paused = true;
  private idleWindowPending = false;
  private idleCancel: (() => void) | undefined;

  constructor(options: PipelineWarmupQueueOptions = {}) {
    if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)) {
      throw new TypeError("Pipeline warmup concurrency must be a positive safe integer.");
    }
    if (options.scheduler !== undefined && typeof options.scheduler !== "function") throw new TypeError("Pipeline warmup scheduler must be a function.");
    this.concurrency = options.concurrency ?? 2;
    this.idleScheduling = options.idleScheduling === true;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get stats(): { pending: number; inFlight: number; paused: boolean } {
    return { pending: this.queue.length, inFlight: this.inFlight, paused: this.paused };
  }

  /** 入队并返回该任务的完成 promise;暂停期间绝不启动。 */
  enqueue<T>(task: WarmupTask<T>): Promise<T> {
    if (!task || typeof task.create !== "function") throw new TypeError("Pipeline warmup task requires create().");
    const priority = task.priority ?? "background";
    if (!PRIORITY_ORDER.includes(priority)) throw new TypeError(`Unknown pipeline warmup priority ${priority}.`);
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask = {
        fingerprint: task.fingerprint, label: task.label, priority, inFlight: false,
        start: () => {
          queued.inFlight = true;
          this.inFlight += 1;
          task.create().then(value => {
            resolve(value);
          }, error => {
            reject(error);
          }).finally(() => {
            this.inFlight -= 1;
            this.pump();
            if (this.inFlight === 0) {
              for (const complete of this.drainWaiters) complete();
              this.drainWaiters.clear();
            }
          });
        },
      };
      const insertAt = this.queue.findIndex(existing => PRIORITY_ORDER.indexOf(existing.priority) > PRIORITY_ORDER.indexOf(priority));
      if (insertAt === -1) this.queue.push(queued); else this.queue.splice(insertAt, 0, queued);
      this.pump();
    });
  }

  pause(): void {
    this.paused = true;
    this.idleCancel?.();
    this.idleCancel = undefined;
    this.idleWindowPending = false;
  }

  resume(): void {
    this.paused = false;
    this.pump();
  }

  /** 等待全部在飞任务结算(不启动新任务;失败不抛)。 */
  async drainInFlight(): Promise<void> {
    if (this.inFlight > 0) await new Promise<void>(resolve => { this.drainWaiters.add(resolve); });
  }

  private pump(): void {
    if (this.paused) return;
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const next = this.queue[0]!;
      if (next.priority === "idle" && this.idleScheduling) {
        if (this.idleWindowPending) return;
        this.idleWindowPending = true;
        this.idleCancel = this.scheduler(() => {
          this.idleWindowPending = false;
          this.idleCancel = undefined;
          if (!this.paused && this.queue[0] === next && this.inFlight < this.concurrency) {
            this.queue.shift();
            next.start();
          }
          // 队头被更高优先级插队等情况交回 pump 统一裁决。
          this.pump();
        });
        return;
      }
      this.queue.shift();
      next.start();
    }
  }
}
