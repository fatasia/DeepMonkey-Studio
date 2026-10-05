import { describe, expect, it } from "vitest";
import { assessHeapWatermark, DEFAULT_HEAP_WATERMARK_MIB, MINIMUM_WATERMARK_SAMPLES } from "./viewerSoakHeapWatermark.mjs";

const MIB = 1024 * 1024;

function series(mibByIndex, key = "usedJsHeapBytes") {
  return Object.entries(mibByIndex).map(([index, mib]) => ({ index: Number(index), [key]: mib * MIB }));
}

describe("viewer soak heap watermark gate", () => {
  it("passes under the watermark and reports the measured peak", () => {
    const result = assessHeapWatermark(series({ 0: 31, 1: 120, 2: 300, 3: 500, 4: 640, 5: 700 }));
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ measured: true, peakMib: 700, watermarkMib: DEFAULT_HEAP_WATERMARK_MIB });
    expect(result.failure).toBeUndefined();
  });

  it("fails above the watermark when the peak sits at the tail (no falloff signature)", () => {
    const samples = series({ 0: 31, 1: 200, 2: 400, 3: 600, 4: 900, 5: 1200, 6: 1458 });
    const result = assessHeapWatermark(samples);
    expect(result.ok).toBe(false);
    expect(result.falloff).toBe(false);
    expect(result.failure).toContain("1458");
    expect(result.failure).toContain(String(DEFAULT_HEAP_WATERMARK_MIB));
    expect(result.failure).toContain("7/7");
    expect(result.failure).toContain("先涨后落");
  });

  it("passes above the watermark only with a growth-then-falloff signature", () => {
    // 峰值在第 2/10 个样本(前 60%),尾段回落到峰值的 20% —— GC 追不上形态。
    const samples = series({ 0: 31, 1: 900, 2: 1458, 3: 1100, 4: 800, 5: 600, 6: 400, 7: 320, 8: 300, 9: 290 });
    const result = assessHeapWatermark(samples);
    expect(result.ok).toBe(true);
    expect(result.falloff).toBe(true);
    expect(result.peakMib).toBe(1458);
    expect(result.note).toContain("增长-回落特征");
    expect(result.failure).toBeUndefined();
  });

  it("fails above the watermark when there are too few samples to judge the falloff", () => {
    const samples = series({ 0: 31, 1: 900, 2: 1458 });
    const result = assessHeapWatermark(samples, { minimumSamples: MINIMUM_WATERMARK_SAMPLES });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("不足以判回落特征");
  });

  it("measures the operating peak from pre-gc samples with post-gc fallback", () => {
    const samples = [
      { index: 0, usedJsHeapBytes: 700 * MIB, postGcUsedJsHeapBytes: 100 * MIB },
      { index: 1, postGcUsedJsHeapBytes: 650 * MIB },
      { index: 2, usedJsHeapBytes: 690 * MIB, postGcUsedJsHeapBytes: 120 * MIB },
    ];
    const result = assessHeapWatermark(samples);
    expect(result.peakMib).toBe(700);
    expect(result.ok).toBe(true);
  });

  it("stays silent without heap telemetry instead of faking numbers", () => {
    expect(assessHeapWatermark([{ index: 0 }, { index: 1 }])).toMatchObject({ ok: true, measured: false });
    expect(assessHeapWatermark(undefined)).toMatchObject({ ok: true, measured: false });
  });
});
