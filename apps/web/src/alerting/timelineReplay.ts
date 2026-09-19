import type { SignalSample } from "./alertEngine";

// P4 时序回放与时间轴·切片一（2026-09-19 用户批准的轻量切片）：
// 历史数据序列 → 回放播放头（play/pause/seek/倍速）→ 按工业阶跃语义输出
// SignalSample，可直接喂给 AlertEngine.evaluate 做回放期告警复现。
// 纯逻辑核心；时间轴 UI 由面板集成切片承担。

export interface TimelineEntry {
  at: number;
  values: Record<string, number>;
}

export interface TimelineSource {
  /** 修订标识：回放必须能声明自己处于哪个数据版本（G06 语义）。 */
  revision: string;
  entries: TimelineEntry[];
}

export type ReplayInterpolation = "step-hold" | "linear";

export interface ReplayClock {
  /** 回放当前时刻（序列时间轴，毫秒）。 */
  playheadMs: number;
  playing: boolean;
  /** 倍速：1=实时，4=四倍速推进。 */
  speed: number;
}

export interface TimelineReplayOptions {
  interpolation?: ReplayInterpolation;
  /** 回放开始前/结束后的语义：hold=保持首末值（默认），none=无信号。 */
  edgeBehavior?: "hold" | "none";
}

const DEFAULT_OPTIONS: Required<TimelineReplayOptions> = { interpolation: "step-hold", edgeBehavior: "hold" };

/** 校验并归一时间轴：按 at 排序（稳定），同刻重复保留最后写入（G06 乱序写入的诚实降级）。 */
export function normalizeTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const out: TimelineEntry[] = [];
  for (const entry of sorted) {
    const previous = out[out.length - 1];
    if (previous && previous.at === entry.at) out[out.length - 1] = entry;
    else out.push(entry);
  }
  return out;
}

export class TimelineReplay {
  private readonly options: Required<TimelineReplayOptions>;
  private readonly entries: TimelineEntry[];
  private revision: string;
  private playheadMs: number;
  private playing = false;
  private speed: number;

  constructor(private readonly source: TimelineSource, options: TimelineReplayOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.entries = normalizeTimeline(source.entries);
    this.revision = source.revision;
    this.playheadMs = this.entries[0]?.at ?? 0;
    this.speed = 1;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  get range(): { from: number; to: number } {
    if (this.entries.length === 0) return { from: 0, to: 0 };
    return { from: this.entries[0]!.at, to: this.entries[this.entries.length - 1]!.at };
  }

  play(speed = this.speed): void {
    this.speed = speed > 0 ? speed : 1;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  seek(toMs: number): void {
    const { from, to } = this.range;
    this.playheadMs = Math.min(Math.max(toMs, from), to);
  }

  /** 驱动播放头推进 wallClockDeltaMs（真实时钟增量），返回当前应生效的信号样本。 */
  advance(wallClockDeltaMs: number): SignalSample | null {
    if (this.entries.length === 0) return null;
    if (this.playing) {
      this.playheadMs += wallClockDeltaMs * this.speed;
      const { to } = this.range;
      if (this.playheadMs >= to) {
        this.playheadMs = to;
        this.playing = false;
      }
    }
    return this.sampleAt(this.playheadMs);
  }

  /** 不推进播放头，取当前时刻样本（seek 后立即读数）。 */
  sampleAt(atMs: number): SignalSample | null {
    if (this.entries.length === 0) return null;
    const { interpolation, edgeBehavior } = this.options;
    const first = this.entries[0]!;
    const last = this.entries[this.entries.length - 1]!;
    if (atMs <= first.at) {
      return edgeBehavior === "hold" ? { at: atMs, values: { ...first.values } } : null;
    }
    if (atMs >= last.at) {
      return edgeBehavior === "hold" ? { at: atMs, values: { ...last.values } } : null;
    }
    let upper = 0;
    while (upper < this.entries.length && this.entries[upper]!.at <= atMs) upper += 1;
    const before = this.entries[upper - 1]!;
    const after = this.entries[upper] ?? before;
    if (interpolation === "step-hold" || before.at === after.at) {
      return { at: atMs, values: { ...before.values } };
    }
    const ratio = (atMs - before.at) / (after.at - before.at);
    const keys = new Set([...Object.keys(before.values), ...Object.keys(after.values)]);
    const values: Record<string, number> = {};
    for (const key of keys) {
      const from = before.values[key];
      const to = after.values[key];
      if (from === undefined || to === undefined) {
        // 一侧缺失的信号不做线性外推：取后值（阶跃语义），如实反映采样缺口。
        values[key] = to ?? from ?? 0;
        continue;
      }
      values[key] = from + (to - from) * ratio;
    }
    return { at: atMs, values };
  }

  get revisionId(): string {
    return this.revision;
  }

  get clock(): ReplayClock {
    return { playheadMs: this.playheadMs, playing: this.playing, speed: this.speed };
  }
}
