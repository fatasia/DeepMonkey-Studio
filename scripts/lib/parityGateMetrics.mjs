import { computeBlockSsim } from "./pixelParity.mjs";

// 像素一致性门度量：全部为纯函数，无 IO。输入为 RGBA8 显示字节（three 与 Deep 同一 320×192 画布）。
// 色差口径：sRGB(D65) → CIELAB，ΔE76 与 CIEDE2000（kL=kC=kH=1）同时给出；SSIM 复用 pixelParity 的分块 SSIM（亮度 0.2126/0.7152/0.0722）。

const toLinear = Array.from({ length: 256 }, (_, value) => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
const WHITE = [0.95047, 1, 1.08883];
const labF = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;

export function srgbBytesToLab(r, g, b) {
  const lr = toLinear[r], lg = toLinear[g], lb = toLinear[b];
  const x = .4124564 * lr + .3575761 * lg + .1804375 * lb, y = .2126729 * lr + .7151522 * lg + .072175 * lb, z = .0193339 * lr + .119192 * lg + .9503041 * lb;
  const fx = labF(x / WHITE[0]), fy = labF(y / WHITE[1]), fz = labF(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE76(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

const rad = degrees => degrees * Math.PI / 180, deg = radians => radians * 180 / Math.PI;
/** CIEDE2000（Sharma 2005 实现，kL=kC=kH=1）。 */
export function deltaE2000(a, b) {
  const [L1, a1, b1] = a, [L2, a2, b2] = b;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const G = .5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2, Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (y, x) => x === 0 && y === 0 ? 0 : (deg(Math.atan2(y, x)) + 360) % 360, hp1 = hp(b1, ap1), hp2 = hp(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0; if (Cp1 * Cp2 !== 0) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(rad(dh / 2));
  const Lbar = (L1 + L2) / 2, Cpbar = (Cp1 + Cp2) / 2;
  let hbar = hp1 + hp2; if (Cp1 * Cp2 === 0) hbar = hp1 + hp2; else if (Math.abs(hp1 - hp2) <= 180) hbar /= 2; else hbar = (hbar + (hbar < 360 ? 360 : -360)) / 2;
  const T = 1 - .17 * Math.cos(rad(hbar - 30)) + .24 * Math.cos(rad(2 * hbar)) + .32 * Math.cos(rad(3 * hbar + 6)) - .2 * Math.cos(rad(4 * hbar - 63));
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
  const Sl = 1 + .015 * (Lbar - 50) ** 2 / Math.sqrt(20 + (Lbar - 50) ** 2), Sc = 1 + .045 * Cpbar, Sh = 1 + .015 * Cpbar * T, Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + .5))];

/** 单场景全帧度量。`coverage` 为任一侧非黑像素数，用于拦截"两边都画空帧也算一致"。 */
export function measureFrame({ width, height, three, deep, threeHdr, deepHdr }) {
  const count = width * height;
  if (three.length !== count * 4 || deep.length !== count * 4) throw Error("Display frame dimensions differ");
  let squared = 0, byteMax = 0, absolute = 0, over8 = 0, over32 = 0, coverage = 0, lumaBias = 0;
  const lumaThree = new Float64Array(count), lumaDeep = new Float64Array(count), d76 = new Float64Array(count), d00 = new Float64Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 4;
    let max = 0, lit = false;
    for (let lane = 0; lane < 3; lane++) {
      const error = Math.abs(three[at + lane] - deep[at + lane]);
      squared += error * error; absolute += error; if (error > max) max = error;
      if (three[at + lane] > 0 || deep[at + lane] > 0) lit = true;
    }
    byteMax = Math.max(byteMax, max, Math.abs(three[at + 3] - deep[at + 3]));
    if (max > 8) over8++; if (max > 32) over32++; if (lit) coverage++;
    lumaThree[pixel] = .2126 * three[at] + .7152 * three[at + 1] + .0722 * three[at + 2];
    lumaDeep[pixel] = .2126 * deep[at] + .7152 * deep[at + 1] + .0722 * deep[at + 2];
    lumaBias += lumaDeep[pixel] - lumaThree[pixel];
    const labThree = srgbBytesToLab(three[at], three[at + 1], three[at + 2]), labDeep = srgbBytesToLab(deep[at], deep[at + 1], deep[at + 2]);
    d76[pixel] = deltaE76(labThree, labDeep); d00[pixel] = deltaE2000(labThree, labDeep);
  }
  const stats = values => {
    const sorted = Array.from(values).sort((a, b) => a - b), mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    return { mean, p99: percentile(sorted, .99), max: sorted[sorted.length - 1] };
  };
  const ssim = computeBlockSsim(lumaDeep, lumaThree, width, height, 16, 12);
  const metrics = { rmse: Math.sqrt(squared / (count * 3)), byteMax, meanAbs: absolute / (count * 3), over8Fraction: over8 / count, over32Fraction: over32 / count,
    deltaE76: stats(d76), deltaE2000: stats(d00), ssim: { mean: ssim.mean, min: ssim.min }, lumaBias: lumaBias / count, coverage };
  if (threeHdr && deepHdr) {
    let hdrSquared = 0, hdrMax = 0, reference = 0;
    for (let i = 0; i < threeHdr.length; i++) { const error = Math.abs(threeHdr[i] - deepHdr[i]); hdrSquared += error * error; hdrMax = Math.max(hdrMax, error); reference += threeHdr[i] * threeHdr[i]; }
    metrics.hdr = { rmse: Math.sqrt(hdrSquared / threeHdr.length), max: hdrMax, relativeRmse: Math.sqrt(hdrSquared / Math.max(reference, 1e-12)) };
  }
  return metrics;
}

/** 分级阈值：严格（实现级等价）/ 容许（视觉等价）/ 诊断（仅记录并受回归守卫约束）。 */
export const PARITY_TIERS = Object.freeze({
  strict: Object.freeze({ rmse: 1.5, deltaE2000Mean: .5, deltaE2000P99: 3, ssimMean: .995 }),
  tolerant: Object.freeze({ rmse: 6, deltaE2000Mean: 2, deltaE2000P99: 10, ssimMean: .97 }),
});
export const TIER_RANK = Object.freeze({ diagnostic: 0, tolerant: 1, strict: 2 });

export function metricsTier(metrics) {
  const within = limit => metrics.rmse <= limit.rmse && metrics.deltaE2000.mean <= limit.deltaE2000Mean && metrics.deltaE2000.p99 <= limit.deltaE2000P99 && metrics.ssim.mean >= limit.ssimMean;
  return within(PARITY_TIERS.strict) ? "strict" : within(PARITY_TIERS.tolerant) ? "tolerant" : "diagnostic";
}

/** 回归守卫：相对已提交基线的容差（绝对余量 + 相对余量），保证已知缺口只能不变或变好。 */
export const REGRESSION_MARGIN = Object.freeze({ rmse: { relative: .1, absolute: .25 }, deltaE2000Mean: { relative: .1, absolute: .1 },
  deltaE2000P99: { relative: .15, absolute: .5 }, ssimMean: { absolute: .005 }, over8Fraction: { relative: .15, absolute: .002 }, hdrRelativeRmse: { relative: .1, absolute: .0005 } });

export function regressionViolations(metrics, baseline) {
  const actual = { rmse: metrics.rmse, deltaE2000Mean: metrics.deltaE2000.mean, deltaE2000P99: metrics.deltaE2000.p99, ssimMean: metrics.ssim.mean, over8Fraction: metrics.over8Fraction, hdrRelativeRmse: metrics.hdr?.relativeRmse };
  const violations = [];
  for (const [name, margin] of Object.entries(REGRESSION_MARGIN)) {
    const base = baseline[name];
    if (base === undefined) continue;
    if (actual[name] === undefined) { violations.push({ name, actual: "missing", limit: base }); continue; }
    if (name === "ssimMean") { if (actual[name] < base - margin.absolute) violations.push({ name, actual: actual[name], limit: base - margin.absolute }); continue; }
    const limit = base * (1 + margin.relative) + margin.absolute;
    if (actual[name] > limit) violations.push({ name, actual: actual[name], limit });
  }
  return violations;
}

export function baselineOf(metrics) {
  return { rmse: metrics.rmse, deltaE2000Mean: metrics.deltaE2000.mean, deltaE2000P99: metrics.deltaE2000.p99, ssimMean: metrics.ssim.mean, over8Fraction: metrics.over8Fraction, ...(metrics.hdr ? { hdrRelativeRmse: metrics.hdr.relativeRmse } : {}) };
}

/** 对一次完整运行判定：场景集合必须完整、覆盖率非空、档位不低于声明、且不超出回归守卫。 */
export function evaluateParityRun(scenarios, expectations) {
  const ids = Object.keys(expectations);
  if (scenarios.length !== ids.length || !ids.every(id => scenarios.some(scenario => scenario.id === id))) throw Error(`Parity scenario set mismatch: ${scenarios.map(scenario => scenario.id)} vs ${ids}`);
  return scenarios.map(scenario => {
    const expectation = expectations[scenario.id], tier = metricsTier(scenario.metrics), failures = [];
    if (scenario.metrics.coverage < expectation.minCoverage) failures.push(`coverage ${scenario.metrics.coverage} < ${expectation.minCoverage}`);
    if (TIER_RANK[tier] < TIER_RANK[expectation.expectedTier]) failures.push(`tier ${tier} below expected ${expectation.expectedTier}`);
    for (const violation of regressionViolations(scenario.metrics, expectation.baseline)) failures.push(`regression ${violation.name}: ${violation.actual} exceeds ${violation.limit}`);
    const improved = TIER_RANK[tier] > TIER_RANK[expectation.expectedTier];
    return { id: scenario.id, tier, expectedTier: expectation.expectedTier, passed: failures.length === 0, failures, ratchet: improved ? `tier improved to ${tier}; raise expectedTier` : undefined };
  });
}
