import type { ConfidenceInterval } from "./model.js";

/** 95% t 区间；小样本不伪装成正态大样本精度。 */
export function confidenceInterval95(samples: readonly number[]): ConfidenceInterval {
  if (samples.length === 0) return { mean: 0, sampleStandardDeviation: 0, lower95: 0, upper95: 0, samples: 0 };
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  if (samples.length === 1) return { mean, sampleStandardDeviation: 0, lower95: mean, upper95: mean, samples: 1 };
  const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / (samples.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const margin = tCritical(samples.length - 1) * standardDeviation / Math.sqrt(samples.length);
  return { mean, sampleStandardDeviation: standardDeviation, lower95: mean - margin, upper95: mean + margin, samples: samples.length };
}

function tCritical(degreesOfFreedom: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045];
  if (degreesOfFreedom <= table.length) return table[degreesOfFreedom - 1] ?? table[0]!;
  if (degreesOfFreedom <= 40) return 2.021;
  if (degreesOfFreedom <= 60) return 2;
  if (degreesOfFreedom <= 120) return 1.98;
  return 1.96;
}
