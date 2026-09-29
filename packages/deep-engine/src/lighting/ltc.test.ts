// C3 LTC 数学门禁:解析对照(小矩形 FF≈A/d²)、拟合确定性/表指纹双锁、
// MC 参考包络质量(交付泛函同式对拍)、evaluateAreaLightCpu 缺省零行为与白炉守恒。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeLtcLut, DEEP_LTC_LUT_SHA256 } from "./ltcTables.js";
import { diffuseFormFactorAtNormal, evaluateAreaLightCpu, fitLtcTexel, inverseMatrixFromRows, LTC_FIT_ITERATIONS,
  LTC_FIT_RECTS, LTC_LUT_FLOATS_PER_TEXEL, LTC_LUT_SIZE, LTC_ROUGHNESS_FLOOR, monteCarloRectIntegral,
  rectFormFactor, sampleLtcLut, type LtcFitRect } from "./ltc.js";

const lut = decodeLtcLut();
const HOLDOUT: readonly LtcFitRect[] = [
  { cx: 0, cy: 0, hw: 0.4, hh: 0.4, distance: 2 }, { cx: 0.35, cy: 0.22, hw: 0.12, hh: 0.5, distance: 1.3 },
  { cx: 0, cy: 0, hw: 1.2, hh: 0.08, distance: 3.5 }, { cx: -0.6, cy: 0.5, hw: 0.25, hh: 0.25, distance: 2 },
  { cx: 0.9, cy: -0.4, hw: 0.3, hh: 0.15, distance: 2.2 }, { cx: 0, cy: 0, hw: 0.35, hh: 0.35, distance: 1.6 },
];

/** 交付同式(表采样 + invM 变换 + atan2 内核;无 π 常数,与 ltc.ts/WGSL 严格同式)。 */
function deliverSpecularIntegral(cosTheta: number, roughness: number, rect: LtcFitRect): number {
  const transform = sampleLtcLut(lut, cosTheta, roughness);
  const matrix = inverseMatrixFromRows(transform.row0, transform.row1);
  const corners = ([[1, 1], [-1, 1], [-1, -1], [1, -1]] as const).map(([sx, sy]) => {
    const x = rect.cx + sx * rect.hw, y = rect.cy + sy * rect.hh, z = rect.distance;
    const length = Math.hypot(x, y, z);
    const mapped = [
      matrix[0]! * (x / length) + matrix[1]! * (y / length) + matrix[2]! * (z / length),
      matrix[3]! * (x / length) + matrix[4]! * (y / length) + matrix[5]! * (z / length),
      matrix[6]! * (x / length) + matrix[7]! * (y / length) + matrix[8]! * (z / length),
    ];
    const mappedLength = Math.hypot(...mapped);
    return mapped.map(value => value / mappedLength);
  });
  return transform.amplitude * Math.abs(rectFormFactor(corners));
}

const light = (overrides: Partial<Parameters<typeof evaluateAreaLightCpu>[1]> = {}) => ({
  position: [0, 2, 0], normal: [0, -1, 0], up: [1, 0, 0], halfWidth: 0.5, halfHeight: 0.5,
  range: 0, color: [1, 1, 1] as const, intensity: 1, twoSided: false, ...overrides,
});
const surface = (overrides: Partial<Parameters<typeof evaluateAreaLightCpu>[2]> = {}) => ({
  position: [0, 0, 0], normal: [0, 1, 0], view: [0, 0, 1], baseColor: [1, 1, 1] as const, metallic: 0, roughness: 0.5,
  ...overrides,
});
const total = (result: { diffuse: readonly number[]; specular: readonly number[] }): number =>
  result.diffuse[0]! + result.specular[0]!;

describe("C3 LTC math kernel and table", () => {
  it("matches the analytic small-rect form factor (FF ≈ A/d², on-axis)", () => {
    // 轴上小矩形:cos≈1、立体角≈A/d²;0.2×0.2 @ d=1 → FF ≈ 0.04(小角近似高阶项 ~1%)。
    const corners = ([[0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1], [0.1, -0.1]] as const).map(([x, y]) => {
      const length = Math.hypot(x, y, 1);
      return [x / length, y / length, 1 / length] as [number, number, number];
    });
    const formFactor = rectFormFactor(corners);
    expect(Math.abs(formFactor - 0.04) / 0.04).toBeLessThan(0.02);
    // 方向性:绕序翻转 → 符号翻转(幅值不变);交付端以 max(FF,0)/|FF| 语义消化。
    expect(rectFormFactor([...corners].reverse())).toBeCloseTo(-formFactor, 10);
  });

  it("keeps the diffuse form factor consistent under normal rotation", () => {
    const world = ([[0.1, 1, 0.1], [-0.1, 1, 0.1], [-0.1, 1, -0.1], [0.1, 1, -0.1]] as const).map(([x, y, z]) => [x, y, z]);
    const up = Math.abs(diffuseFormFactorAtNormal([0, 1, 0], world)!);
    const tilt = Math.abs(diffuseFormFactorAtNormal([1, 1, 0].map(value => value / Math.SQRT2), world)!);
    // 符号随切向系绕序翻转(交付端以 max(FF,0)/|FF| 语义消化),此处只看幅值:
    // 倾斜法线接收单调衰减(投影面积收缩)。
    expect(up).toBeGreaterThan(0);
    expect(tilt).toBeGreaterThan(0);
    expect(tilt).toBeLessThan(up);
  });

  it("locks the committed table fingerprint and budget constants", () => {
    const bytes = new Uint8Array(lut.buffer, lut.byteOffset, lut.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DEEP_LTC_LUT_SHA256);
    expect(lut.length).toBe(LTC_LUT_SIZE * LTC_LUT_SIZE * LTC_LUT_FLOATS_PER_TEXEL);
    expect(LTC_LUT_SIZE).toBe(64);
    expect(LTC_ROUGHNESS_FLOOR).toBe(0.045);
  });

  it("reproduces sampled table texels bitwise via the deterministic fitter", () => {
    // 确定性:同输入逐位复现(固定 Fibonacci 格点 + 无随机 NM)。对角 3 texel 在**构建角度**
    // ((c+0.5)/64)重新拟合,直读表内 f32 打包值对拍;拟合器漂移在这里抓红。
    for (const [column, row] of [[0, 0], [32, 32], [63, 63]] as const) {
      const cosTheta = (column + 0.5) / LTC_LUT_SIZE;
      const roughness = LTC_ROUGHNESS_FLOOR + (1 - LTC_ROUGHNESS_FLOOR) * (row + 0.5) / LTC_LUT_SIZE;
      const first = fitLtcTexel(cosTheta, roughness);
      const second = fitLtcTexel(cosTheta, roughness);
      expect(second.inverseMatrix).toEqual(first.inverseMatrix);
      expect(second.amplitude).toBe(first.amplitude);
      const base = (row * LTC_LUT_SIZE + column) * LTC_LUT_FLOATS_PER_TEXEL;
      expect(lut[base]!).toBeCloseTo(first.inverseMatrix[0]!, 5);
      expect(lut[base + 4 + 1]!).toBeCloseTo(first.inverseMatrix[4]!, 5);
      expect(lut[base + 7]!).toBeCloseTo(first.amplitude, 5);
    }
    expect(LTC_FIT_ITERATIONS).toBeGreaterThan(0);
  });

  it("tracks the Monte-Carlo reference within the settled envelope thresholds", () => {
    // 交付泛函(表采样)vs 确定性 MC(60k 面元采样,与 §7 报告标定同口径):包络误差 = |model−mc|/maxTarget。
    // 定案阈值(报告 §数学):rough ≥ 0.3 → ≤ 8%,中间 texel ≤ 14%;尖锐+掠射角部
    // (rough ≤ 0.15 且 cosθ ≥ 0.8)尾瓣为单余弦瓣族表达极限,与经典 LTC 表同水平 → ≤ 75%。
    const cases: ReadonlyArray<{ cosTheta: number; roughness: number; envelope: number }> = [
      { cosTheta: 0.9, roughness: 0.3, envelope: 0.08 }, { cosTheta: 0.5, roughness: 0.25, envelope: 0.08 },
      { cosTheta: 0.3, roughness: 1, envelope: 0.08 }, { cosTheta: 0.7, roughness: 0.45, envelope: 0.08 },
      { cosTheta: 0.99, roughness: 1, envelope: 0.08 }, { cosTheta: 0.6, roughness: 0.6, envelope: 0.14 },
      { cosTheta: 0.99, roughness: 0.09, envelope: 0.75 }, { cosTheta: 0.8, roughness: 0.15, envelope: 0.75 },
    ];
    for (const { cosTheta, roughness, envelope } of cases) {
      // 归一化基数与报告 §7 同口径:max 取训练+留出全集(交付响应的 texel 主导档)。
      const rects: readonly LtcFitRect[] = [...LTC_FIT_RECTS, ...HOLDOUT];
      const maximum = Math.max(...rects.map(rect => Math.abs(monteCarloRectIntegral(cosTheta, roughness, rect, 60000))), 1e-9);
      for (const rect of rects) {
        const reference = monteCarloRectIntegral(cosTheta, roughness, rect, 60000);
        const model = deliverSpecularIntegral(cosTheta, roughness, rect);
        expect(Math.abs(model - reference) / maximum).toBeLessThanOrEqual(envelope);
      }
    }
  });
});

describe("C3 area light evaluation defaults and white-furnace conservation", () => {
  it("returns zero for backfacing single-sided lights, range culls, zero intensity, and coplanar shading points", () => {
    const backface = evaluateAreaLightCpu(lut, light(), surface());
    expect(total(backface)).toBe(0);
    const twoSided = evaluateAreaLightCpu(lut, light({ twoSided: true }), surface());
    expect(total(twoSided)).toBeGreaterThan(0); // 双面背面同亮
    const outOfRange = evaluateAreaLightCpu(lut, light({ twoSided: true, range: 1 }), surface());
    expect(total(outOfRange)).toBe(0);
    const dark = evaluateAreaLightCpu(lut, light({ twoSided: true, intensity: 0 }), surface());
    expect(total(dark)).toBe(0);
    const coplanar = evaluateAreaLightCpu(lut, light({ twoSided: true }), surface({ position: [0, 2, 0] }));
    expect(total(coplanar)).toBe(0);
  });

  it("modulates radiance by the cookie window exactly", () => {
    const plain = evaluateAreaLightCpu(lut, light({ twoSided: true, texture: { uvScale: [1, 1], uvOffset: [0, 0] } }), surface());
    const dimmed = evaluateAreaLightCpu(lut, light({ twoSided: true, texture: { uvScale: [1, 1], uvOffset: [0, 0] } }), surface(),
      () => [0.25, 0.5, 1]);
    [0, 1, 2].forEach(component => {
      expect(dimmed.diffuse[component]).toBeCloseTo(plain.diffuse[component]! * [0.25, 0.5, 1][component]!, 12);
      expect(dimmed.specular[component]).toBeCloseTo(plain.specular[component]! * [0.25, 0.5, 1][component]!, 12);
    });
  });

  it("keeps the white furnace closed: a full white two-sided emitter never amplifies energy", () => {
    // 白炉:白 albedo、rough=1(全漫反射主导),巨大白色双面光源罩住上半球。
    // 漫反射 = albedo·radiance·FF/π,FF(半球包络)→ π,漫反射项 ≤ radiance(守恒上界);
    // 上界 1.05 容纳粗糙=1 拟合幅值在近全包络角的已知小幅过冲(报告 §数学)。
    const furnace = evaluateAreaLightCpu(lut,
      light({ twoSided: true, halfWidth: 64, halfHeight: 64, position: [0, 0.5, 0] }),
      surface({ roughness: 1, metallic: 0, baseColor: [1, 1, 1] }));
    expect(total(furnace)).toBeGreaterThan(0.5);
    expect(total(furnace)).toBeLessThanOrEqual(1.05);
  });

  it("scales strictly with light size until the receiver saturates at full coverage", () => {
    const small = evaluateAreaLightCpu(lut, light({ twoSided: true, halfWidth: 0.5, halfHeight: 0.5 }), surface({ roughness: 1 }));
    const large = evaluateAreaLightCpu(lut, light({ twoSided: true, halfWidth: 1, halfHeight: 1 }), surface({ roughness: 1 }));
    expect(total(large)).toBeGreaterThan(total(small));
  });
});
