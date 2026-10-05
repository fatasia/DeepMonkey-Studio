/**
 * A2 内存专项(刀3):长稳堆水位门。
 *
 * 判据(双通道,满足其一即通过):
 * 1. 硬水位:峰值堆(逐样本 usedJsHeapBytes,缺失回退 postGc)≤ 水位线;
 * 2. 「增长率+回落特征」:超线但峰值出现在前 60% 样本内、且尾段(最后 5 个样本)
 *    中位数回落 ≥40% —— 这是 GC 追不上而非泄漏的形态(release-soak-20261005
 *    实测:heap 前半 +192.5MB/min、峰 1458 MiB、后半 -4.4MB/min 缓降)。
 *
 * 水位线 800 MiB 是 headless 保守线(同轮生产 soak 31 MiB 起步、峰 1458 MiB),
 * 待非 headless 复跑定标后收紧;失败信息必须带数值,禁止静态文案。
 * 纯函数,无 I/O;构造样本测试见 viewerSoakHeapWatermark.test.mjs。
 */

export const DEFAULT_HEAP_WATERMARK_MIB = 800;
/** 回落特征要求的最少样本数;不足以判特征时超线即失败(保守)。 */
export const MINIMUM_WATERMARK_SAMPLES = 6;
/** 峰值允许出现的样本前缀比例(先涨后落的「涨」段)。 */
const GROWTH_PHASE_RATIO = 0.6;
/** 尾段中位相对峰值的最小回落幅度。 */
const FALLOFF_RATIO = 0.6;

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * @param samples 长稳样本数组(至少含 usedJsHeapBytes 或 postGcUsedJsHeapBytes 字节值)
 * @param options {{ watermarkMib?: number, minimumSamples?: number }}
 * @returns {{ ok: boolean, measured: boolean, peakMib?: number, watermarkMib: number,
 *   peakSampleIndex?: number, sampleCount?: number, tailMedianMib?: number,
 *   falloff?: boolean, note?: string, failure?: string }}
 */
export function assessHeapWatermark(samples, options = {}) {
  const watermarkMib = Number.isFinite(options.watermarkMib) ? options.watermarkMib : DEFAULT_HEAP_WATERMARK_MIB;
  const minimumSamples = Number.isFinite(options.minimumSamples) ? options.minimumSamples : MINIMUM_WATERMARK_SAMPLES;
  const points = (samples ?? [])
    .map((sample, index) => ({ index, bytes: sample?.usedJsHeapBytes ?? sample?.postGcUsedJsHeapBytes }))
    .filter((point) => Number.isFinite(point.bytes));
  // 无堆遥测:门不判(与既有增长门对 Number.isFinite 的口径一致),不伪零不误报。
  if (points.length === 0) return { ok: true, measured: false, watermarkMib };
  const peak = points.reduce((best, point) => (point.bytes > best.bytes ? point : best), points[0]);
  const peakMib = peak.bytes / 1024 / 1024;
  if (peakMib <= watermarkMib) {
    return { ok: true, measured: true, peakMib: round1(peakMib), watermarkMib,
      peakSampleIndex: peak.index, sampleCount: points.length };
  }
  const tail = points.slice(Math.max(0, points.length - 5));
  const tailMedianMib = median(tail.map((point) => point.bytes)) / 1024 / 1024;
  const falloff = points.length >= minimumSamples
    && peak.index <= Math.floor((points.length - 1) * GROWTH_PHASE_RATIO)
    && tailMedianMib <= peakMib * FALLOFF_RATIO;
  const context = `峰值 ${round1(peakMib)} MiB > 水位 ${watermarkMib} MiB(第 ${peak.index + 1}/${points.length} 个样本),`
    + `尾段中位 ${round1(tailMedianMib)} MiB`;
  if (falloff) {
    return { ok: true, measured: true, peakMib: round1(peakMib), watermarkMib,
      peakSampleIndex: peak.index, sampleCount: points.length, tailMedianMib: round1(tailMedianMib),
      falloff: true, note: `${context};超线但呈增长-回落特征(GC 追不上,非泄漏形态)`
        + ";headless 保守线,待非 headless 定标收紧" };
  }
  return { ok: false, measured: true, peakMib: round1(peakMib), watermarkMib,
    peakSampleIndex: peak.index, sampleCount: points.length, tailMedianMib: round1(tailMedianMib),
    falloff: false,
    failure: `长稳堆水位超限:${context};${points.length < minimumSamples
      ? `样本 ${points.length} 个不足以判回落特征`
      : "峰值位置未呈先涨后落特征"}(headless 保守线,待非 headless 定标收紧)` };
}
