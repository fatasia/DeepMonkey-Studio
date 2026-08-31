const requiredVisualPairs = [["three-webgl", "three-webgpu"]];

/**
 * 校验 WebGPU 一级对比证据是否完整。
 * 性能优劣不在这里裁决；本门禁只阻止“缺数据但报告仍有效”的假结论。
 */
export function assessFirstClassWebGpuEvidence(cases, visualComparisons, expectedRebuildCycles) {
  const failures = [];
  const webGpuCases = cases.filter((item) => item.engine?.endsWith("webgpu"));
  if (!webGpuCases.length) return ["没有 WebGPU 对比用例"];

  for (const item of webGpuCases) {
    const prefix = `${item.engine}/${item.workload}/${item.objectCount}/run-${item.run}`;
    const limits = item.environment?.webGpuLimits;
    if (!limits || Object.values(limits).some((value) => !Number.isFinite(value) || value <= 0)) {
      failures.push(`${prefix}: WebGPU limits 证据不完整`);
    }

    const heapSamples = item.heapSamples ?? [];
    if (heapSamples.length !== expectedRebuildCycles + 1 || heapSamples.some((value) => !Number.isFinite(value))) {
      failures.push(`${prefix}: 缺少完整的重建堆样本`);
    }

    const observations = item.observations;
    if (!observations?.supported) {
      failures.push(`${prefix}: Long Tasks API 不可用，无法形成主线程阻塞证据`);
    } else if (![observations.count, observations.totalMs, observations.maximumMs].every(Number.isFinite)) {
      failures.push(`${prefix}: Long Task 统计不完整`);
    }
  }

  for (const [reference, candidate] of requiredVisualPairs) {
    const comparison = visualComparisons.find((item) => item.reference === reference && item.candidate === candidate);
    if (!comparison) {
      failures.push(`${reference}/${candidate}: 缺少同引擎 WebGL/WebGPU 画质对照`);
      continue;
    }
    if (![comparison.ssim, comparison.meanAbsoluteError, comparison.changedPixelRatio, comparison.severePixelRatio].every(Number.isFinite)) {
      failures.push(`${reference}/${candidate}: 画质指标不完整`);
    } else if (comparison.ssim < 0.7) {
      failures.push(`${reference}/${candidate}: 画面结构相似度仅 ${comparison.ssim.toFixed(3)}`);
    }
  }

  return failures;
}
