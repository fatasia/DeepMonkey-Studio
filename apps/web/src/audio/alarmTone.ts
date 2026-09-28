/**
 * T29 告警声源·确定性双音合成。
 *
 * 诚实条款:真实设备告警声样本缺失(工业告警音受版权与现场采集限制),
 * 本切片用合成双音(IEC/ISO 工业告警常见的 660/880 Hz 交替)作为告警声源,
 * 循环播放由 Web Audio source.loop 承担;真实样本接入后只需替换 buffer 来源,
 * 不改触发与释放逻辑。
 *
 * 纯函数、无随机:同参数输出逐样本一致,可单测(长度/能量/过零频率/循环缝合)。
 * 每段首尾 8ms 余弦淡入淡出,消除段间与循环缝合处的爆音(click)。
 */

export interface AlarmToneOptions {
  /** 采样率(Hz);应与目标 AudioContext.sampleRate 一致,避免重采样失真。 */
  sampleRate: number;
  /** 双音周期数,默认 4(500ms 周期 x 4 = 2s buffer);循环播放用 loop,不必长 buffer。 */
  cycles?: number;
  /** 低音频率,默认 660 Hz。 */
  lowHz?: number;
  /** 高音频率,默认 880 Hz。 */
  highHz?: number;
  /** 一个完整双音周期的毫秒数,默认 500(每段 250ms)。 */
  cycleMs?: number;
  /** 峰值幅度 0..1,默认 0.8。 */
  amplitude?: number;
}

export interface AlarmTonePcm {
  sampleRate: number;
  /** 单声道 PCM,取值 -1..1。 */
  data: Float32Array;
  durationMs: number;
}

export function synthesizeAlarmTonePcm(options: AlarmToneOptions): AlarmTonePcm {
  const sampleRate = Math.max(8000, Math.floor(Number.isFinite(options.sampleRate) ? options.sampleRate : 44100));
  const cycles = Math.max(1, Math.floor(options.cycles ?? 4));
  const cycleMs = Number.isFinite(options.cycleMs) && (options.cycleMs ?? 0) > 0 ? (options.cycleMs as number) : 500;
  const halfSamples = Math.max(1, Math.round((sampleRate * cycleMs) / 2000));
  const fade = Math.min(Math.round(sampleRate * 0.008), Math.floor(halfSamples / 2));
  const amplitude = clamp01(options.amplitude ?? 0.8);
  const lowHz = positiveHz(options.lowHz, 660);
  const highHz = positiveHz(options.highHz, 880);

  const data = new Float32Array(halfSamples * 2 * cycles);
  let cursor = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const hz of [lowHz, highHz]) {
      for (let i = 0; i < halfSamples; i += 1) {
        const phase = 2 * Math.PI * hz * (i / sampleRate);
        data[cursor + i] = Math.sin(phase) * amplitude * fadeEnvelope(i, halfSamples, fade);
      }
      cursor += halfSamples;
    }
  }
  return { sampleRate, data, durationMs: (data.length / sampleRate) * 1000 };
}

/** 过零频率估计:统计窗口内符号翻转次数 / 2 / 窗口时长。仅供测试与诊断。 */
export function estimateZeroCrossingHz(data: Float32Array, sampleRate: number, from: number, to: number): number {
  let crossings = 0;
  const start = Math.max(1, Math.floor(from));
  const end = Math.min(data.length, Math.floor(to));
  for (let i = start; i < end; i += 1) {
    const previous = data[i - 1] ?? 0;
    const current = data[i] ?? 0;
    if (previous <= 0 && current > 0) crossings += 1;
  }
  const seconds = (end - start) / sampleRate;
  return seconds > 0 ? crossings / seconds : 0;
}

function fadeEnvelope(i: number, total: number, fade: number): number {
  if (fade <= 0) return 1;
  if (i < fade) return 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
  if (i >= total - fade) return 0.5 - 0.5 * Math.cos((Math.PI * (total - i)) / fade);
  return 1;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function positiveHz(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}
