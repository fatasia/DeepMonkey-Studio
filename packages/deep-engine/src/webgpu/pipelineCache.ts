import { sha256Utf8 } from "../shaderPackage/hash.js";

/**
 * C26 着色器编译提速(首帧)——逐管线编译缓存与计时。
 *
 * 指纹 = WGSL 源哈希 + 管线描述符稳定序列化(对象引用换成身份令牌)。
 * 因此 WGSL 源变更或描述符任一字段变更都会得到不同指纹:陈旧条目自动失效,
 * 不需要调用方记得手动清理。设备维度用 WeakMap 隔离:设备销毁即随之回收,
 * 两个设备(含设备重建)之间绝不共享 GPU 对象。
 *
 * 每次真实创建记录逐管线编译耗时(F1 的 pbrTimedPassIds 是逐 pass GPU 执行
 * 计时,与编译耗时无关;本清单是 C26 的量化口径来源),缓存命中记录为 0ms。
 */

/** 管线编译耗时清单条目(量化口径)。 */
export interface PipelineCompileRecord {
  readonly fingerprint: string;
  readonly label: string;
  /** 创建调用到 promise 结算的墙钟耗时;缓存命中恒为 0。 */
  readonly durationMs: number;
  readonly cacheHit: boolean;
  readonly failed: boolean;
  /** 结算时刻(monotonic,performance.now 口径;测试注入时钟时为注入值)。 */
  readonly settledAtMs: number;
}

interface CacheEntry {
  readonly promise: Promise<GPURenderPipeline>;
  readonly fingerprint: string;
  readonly label: string;
  startedAtMs: number;
}

export interface PipelineCompileCacheOptions {
  /** 注入单调时钟;缺省 performance.now(不可用时退回 Date.now)。 */
  readonly now?: () => number;
  /** 缓存条目上限;淘汰即释放引用(GPU 管线无 destroy)。缺省 512。 */
  readonly maxEntries?: number;
}

const OBJECT_TOKEN_PREFIX = "@gpu-object:";

/** GPU 对象身份令牌:同一对象恒同令牌,不同对象恒不同令牌(含跨 build 的布局)。 */
const objectIds = new WeakMap<object, string>();
let objectIdCounter = 0;
function objectToken(value: object): string {
  let id = objectIds.get(value);
  if (!id) { id = `${OBJECT_TOKEN_PREFIX}${++objectIdCounter}`; objectIds.set(value, id); }
  return id;
}

/** 管线描述符里唯一可能是 GPU 对象引用的字段路径;其余一律按纯数据序列化。 */
const GPU_REF_PATHS = new Set(["layout", "vertex.module", "fragment.module", "compute.module"]);

/** 描述符稳定序列化:GPU 对象引用替换为身份令牌,其余按 JSON 结构递归。 */
function serializeDescriptor(value: unknown, out: string[], path = ""): void {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value)); return;
  }
  if (typeof value === "string") { out.push(JSON.stringify(value)); return; }
  if (typeof value === "object") {
    if (GPU_REF_PATHS.has(path)) { out.push(objectToken(value)); return; }
    if (value instanceof Map) {
      out.push("map{");
      for (const [key, entry] of [...value.entries()].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1)) {
        out.push(JSON.stringify(String(key)));
        serializeDescriptor(entry, out, path);
      }
      out.push("}"); return;
    }
    if (Array.isArray(value)) {
      out.push("[");
      value.forEach((entry, index) => serializeDescriptor(entry, out, `${path}[${index}]`));
      out.push("]"); return;
    }
    out.push("{");
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out.push(JSON.stringify(key));
      serializeDescriptor((value as Record<string, unknown>)[key], out, path ? `${path}.${key}` : key);
    }
    out.push("}"); return;
  }
  out.push(`fn:${typeof value}`);
}

/** WGSL 源指纹:源变更必失效。 */
export function wgslSourceFingerprint(code: string): string {
  return `wgsl-sha256-${sha256Utf8(code)}`;
}

/** 管线指纹:WGSL 源 + 完整描述符(对象取身份)。描述符漂移即指纹漂移。 */
export function renderPipelineFingerprint(wgslCodes: readonly string[],
  descriptor: GPURenderPipelineDescriptor): string {
  const parts: string[] = wgslCodes.map(code => wgslSourceFingerprint(code));
  serializeDescriptor(descriptor, parts);
  return `pso-sha256-${sha256Utf8(parts.join("\u0000"))}`;
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now() : Date.now();
}

const caches = new WeakMap<GPUDevice, PipelineCompileCache>();

/** 每 device 一份缓存(设备重建 = 新对象 = 天然隔离)。 */
export function pipelineCompileCacheForDevice(device: GPUDevice,
  options: PipelineCompileCacheOptions = {}): PipelineCompileCache {
  let cache = caches.get(device);
  if (!cache) { cache = new PipelineCompileCache(options); caches.set(device, cache); }
  return cache;
}

export class PipelineCompileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly recordLog: PipelineCompileRecord[] = [];
  private readonly now: () => number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(options: PipelineCompileCacheOptions = {}) {
    if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("Pipeline cache clock must be a function.");
    if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)) {
      throw new TypeError("Pipeline cache maxEntries must be a positive safe integer.");
    }
    this.now = options.now ?? defaultNow;
    this.maxEntries = options.maxEntries ?? 512;
  }

  /** 逐管线编译耗时清单快照(量化口径;不清空)。 */
  get records(): readonly PipelineCompileRecord[] { return this.recordLog; }
  get stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses };
  }

  /** 计时记录转移到调用方(报告/持久化),缓存条目保留。 */
  drainRecords(): readonly PipelineCompileRecord[] {
    const drained = [...this.recordLog];
    this.recordLog.length = 0;
    return drained;
  }

  /**
   * 指纹命中则复用(并发去重:未结算条目同样复用);未命中创建并记录耗时。
   * 创建失败剔除条目以便重试,失败同样计入清单。
   * 计时/失效走旁路处理器,返回原始 promise——不增加调用方链上的微任务
   * 跳变,保持 track 增量填充(pipeline map)的既有结算时序。
   */
  create(wgslCodes: readonly string[], descriptor: GPURenderPipelineDescriptor,
    create: () => Promise<GPURenderPipeline>): Promise<GPURenderPipeline> {
    const fingerprint = renderPipelineFingerprint(wgslCodes, descriptor);
    const existing = this.entries.get(fingerprint);
    if (existing) {
      this.hits += 1;
      this.appendRecord({ fingerprint, label: existing.label, durationMs: 0, cacheHit: true, failed: false,
        settledAtMs: this.now() });
      return existing.promise;
    }
    this.misses += 1;
    const entry: CacheEntry = {
      fingerprint, label: descriptor.label ?? "", startedAtMs: this.now(),
      promise: create(),
    };
    this.entries.set(fingerprint, entry);
    void entry.promise.then(pipeline => {
      this.record(entry, false);
      return pipeline;
    }, error => {
      this.record(entry, true);
      if (this.entries.get(fingerprint) === entry) this.entries.delete(fingerprint);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.promise;
  }

  /** 显式失效(热重载/测试);返回是否确有条目被剔除。 */
  invalidate(fingerprint: string): boolean {
    return this.entries.delete(fingerprint);
  }

  /** 清空全部条目(GPU 对象无 destroy,释放即丢弃引用)。 */
  clear(): void { this.entries.clear(); }

  private record(entry: CacheEntry, failed: boolean): void {
    const settledAtMs = this.now();
    this.appendRecord({ fingerprint: entry.fingerprint, label: entry.label,
      durationMs: Math.max(0, settledAtMs - entry.startedAtMs), cacheHit: false, failed, settledAtMs });
  }

  private appendRecord(record: PipelineCompileRecord): void {
    this.recordLog.push(record);
    if (this.recordLog.length > 4096) this.recordLog.splice(0, this.recordLog.length - 4096);
  }
}
