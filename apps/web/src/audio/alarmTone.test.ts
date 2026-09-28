import { describe, expect, it } from "vitest";
import { estimateZeroCrossingHz, synthesizeAlarmTonePcm } from "./alarmTone";

describe("alarm tone synthesis (T29)", () => {
  it("produces deterministic PCM with the expected length and duration", () => {
    const tone = synthesizeAlarmTonePcm({ sampleRate: 44100, cycles: 4 });
    // 500ms 周期 = 每段 250ms = 11025 样本;4 周期 8 段。
    expect(tone.data.length).toBe(11025 * 8);
    expect(tone.durationMs).toBeCloseTo(2000, 6);
    expect(synthesizeAlarmTonePcm({ sampleRate: 44100, cycles: 4 }).data).toEqual(tone.data);
  });

  it("carries the two tones at 660 Hz and 880 Hz within tolerance", () => {
    const sampleRate = 44100;
    const tone = synthesizeAlarmTonePcm({ sampleRate, cycles: 2 });
    const half = tone.data.length / 4; // 每段样本数(4 段 = 2 周期)
    const windowStart = Math.round(half * 0.3);
    const windowEnd = Math.round(half * 0.7);
    const low = estimateZeroCrossingHz(tone.data, sampleRate, windowStart, windowEnd);
    const high = estimateZeroCrossingHz(tone.data, sampleRate, half + windowStart, half + windowEnd);
    // 过零估计在离散采样下有 ±2% 抖动。
    expect(Math.abs(low - 660) / 660).toBeLessThan(0.02);
    expect(Math.abs(high - 880) / 880).toBeLessThan(0.02);
  });

  it("keeps loop seams and segment boundaries click-free", () => {
    const tone = synthesizeAlarmTonePcm({ sampleRate: 44100, cycles: 3 });
    expect(Math.abs(tone.data[0]!)).toBeLessThan(0.02);
    expect(Math.abs(tone.data[tone.data.length - 1]!)).toBeLessThan(0.02);
  });

  it("stays within amplitude bounds and clamps oversized amplitude", () => {
    const loud = synthesizeAlarmTonePcm({ sampleRate: 44100, amplitude: 5 });
    const capped = synthesizeAlarmTonePcm({ sampleRate: 44100, amplitude: 1 });
    expect(loud.data).toEqual(capped.data);
    for (const value of loud.data) expect(Math.abs(value)).toBeLessThanOrEqual(1 + 1e-12);
  });

  it("respects sample rate and non-default tone spacing", () => {
    const tone = synthesizeAlarmTonePcm({ sampleRate: 16000, cycles: 1, cycleMs: 400, lowHz: 520, highHz: 1040 });
    expect(tone.sampleRate).toBe(16000);
    expect(tone.data.length).toBe(16000 * 0.4);
    const half = tone.data.length / 2;
    const low = estimateZeroCrossingHz(tone.data, 16000, half * 0.3, half * 0.7);
    expect(Math.abs(low - 520) / 520).toBeLessThan(0.03);
  });
});
