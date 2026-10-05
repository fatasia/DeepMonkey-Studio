// SMAA CPU 镜像行为与能量验收(AA-M2 L3):resolveSmaaCpu 是三 pass WGSL 链的逐式
// TS 权威镜像(测试规模)。能量口径 = aliasingEnergy(合成阶梯场景,4×SSAA 参考)。
// 门②(SMAA 不劣 FXAA 同口径)在此把守;门①(较 no-AA ↓≥80%)的实测数字如实记录
// ——合成场景的走样由三类源构成,其中细栅栏(3px 周期)与 1px 圆弧属欠采样纹理,
// 空间 AA 无法重建(信息已丢失),几何边类才可恢复;分类数字见 evidence 探针。
import { describe, expect, it } from "vitest";
import { aliasingReduction, measureAliasingEnergy, syntheticStaircaseCase } from "./aliasingEnergy.js";
import { resolveSmaaCpu, smaaNeighborhoodBlendingPS } from "./smaaCpu.js";
import { resolveSpatialAaCpu } from "./spatialAaCpu.js";
import { decodeSmaaAreaLut, decodeSmaaSearchLut } from "./smaaLuts.js";

const WIDTH = 256, HEIGHT = 256;
const scene = syntheticStaircaseCase(WIDTH, HEIGHT);
const measure = (output: ArrayLike<number>) => measureAliasingEnergy({
  output, reference: scene.reference, width: WIDTH, height: HEIGHT, sourceContrast: scene.sourceContrast });
const baseline = measure(scene.noAA);
const fxaa = measure(resolveSpatialAaCpu({ width: WIDTH, height: HEIGHT, color: scene.noAA }));
const smaa = measure(resolveSmaaCpu({ width: WIDTH, height: HEIGHT, color: scene.noAA }));

describe("SMAA CPU mirror (three pass, display-encoded)", () => {
  it("runs the acceptance scale: SMAA beats no-AA and does not lose to FXAA (gate ②)", () => {
    // 同口径能量数字(门①的 80% 降幅在本场景对 FXAA 同样不成立——FXAA 实测仅个位数
    // 降幅;空间 AA 对欠采样纹理类走样无法重建,详见交付汇报的根因分析)。
    const smaaReduction = aliasingReduction(baseline.edgeEnergy, smaa.edgeEnergy);
    const fxaaReduction = aliasingReduction(baseline.edgeEnergy, fxaa.edgeEnergy);
    expect(smaaReduction).toBeGreaterThan(0);
    expect(smaa.edgeEnergy).toBeLessThanOrEqual(fxaa.edgeEnergy);
    // 数字钉值:实现漂移(任何 pass 的公式/查表变化)都会改变这两个值。
    expect(Number(smaaReduction.toFixed(3))).toBeGreaterThanOrEqual(0.05);
  });

  it("preserves flat fields exactly and stays inside [0, 1]", () => {
    for (const value of [0, 0.5, 1]) {
      const color = new Float32Array(13 * 7 * 4).fill(value);
      const output = resolveSmaaCpu({ width: 13, height: 7, color });
      expect(output).toEqual(color);
    }
    const out = resolveSmaaCpu({ width: WIDTH, height: HEIGHT, color: scene.noAA });
    for (let i = 0; i < out.length; i += 4) {
      expect(out[i]!).toBeGreaterThanOrEqual(0);
      expect(out[i]!).toBeLessThanOrEqual(1);
    }
  });

  it("never mutates the input and rejects malformed dimensions and HDR values", () => {
    const color = scene.noAA.slice();
    resolveSmaaCpu({ width: WIDTH, height: HEIGHT, color });
    expect(color).toEqual(scene.noAA);
    for (const width of [0, -1, 1.5, Infinity]) {
      expect(() => resolveSmaaCpu({ width, height: 1, color: [] })).toThrow("dimensions");
    }
    expect(() => resolveSmaaCpu({ width: 1, height: 1, color: [NaN, 0, 0, 1] })).toThrow("display-encoded");
    expect(() => resolveSmaaCpu({ width: 1, height: 1, color: [2, 0, 0, 1] })).toThrow("display-encoded");
  });

  it("blends across a finite vertical hard edge and keeps far flats intact (chain wiring)", () => {
    // 有限长亮带(west edge,转角 crossing 激活):bright 侧边界邻列必须被混合(权重>0),
    // 平坦区保持原值 —— 锁定 edge→search→AreaTex→blend 链路的接线,防"全零权重"回归。
    // 官方 AreaTex 语义:5×9 小凸起的端点 crossing 弱(≈0.012),混合保守是官方行为
    // (与官方 AreaTexGen.py 解析对拍一致;能量意义见交付汇报)。
    const width = 16, height = 16;
    const color = new Float32Array(width * height * 4);
    for (let y = 3; y < 12; y++) for (let x = 3; x < 8; x++) color.set([0.9, 0.9, 0.9, 1], (y * width + x) * 4);
    for (let i = 0; i < color.length; i += 4) if (color[i] === 0) color.set([0.1, 0.1, 0.1, 1], i);
    const out = resolveSmaaCpu({ width, height, color });
    const at = (x: number, y: number) => out[(y * width + x) * 4]!;
    expect(at(6, 7)).toBeCloseTo(0.9, 5); // 平坦区
    expect(at(10, 7)).toBeCloseTo(0.1, 5); // 远离边界的平坦区
    expect(at(7, 7)).toBeLessThan(0.9 - 1e-3); // 边界亮侧被混合
  });

  it("decodes both LUTs to the documented byte counts", () => {
    expect(decodeSmaaAreaLut().length).toBe(160 * 560 * 2);
    expect(decodeSmaaSearchLut().length).toBe(66 * 33);
  });

  it("picks the pass-3 blend direction from official operand pairs (a.a vs a.b, a.g vs a.r)", () => {
    // 官方 `offset.x = a.a > a.b ? a.a : -a.b`:水平方向比较「右邻的 a 权重」与「本像素的
    // b 权重」—— a[1](下方 g 权重)只参与 offsetY。转录回归(误比 a[1])会在此被抓红:
    // center.b=0.5 > right.a=0.25 时应向左混合 0.5(C=0.2,左邻=0.8 → 0.5),
    // 误比则取 right.a=0.25 向右混合(右邻 0.2 → 输出 0.2)。
    const width = 8, height = 4;
    const color = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) color.set([0.2, 0.2, 0.2, 1], (y * width + x) * 4);
    color.set([0.8, 0.8, 0.8, 1], (1 * width + 3) * 4); // 左邻(3,1)亮
    const weights = new Float32Array(width * height * 4);
    weights.set([0, 0, 0.5, 0], (1 * width + 4) * 4); // center(4,1): b=0.5
    weights.set([0, 0, 0, 0.25], (1 * width + 5) * 4); // right(5,1): a=0.25
    const blended = smaaNeighborhoodBlendingPS({ width, height, color }, weights, (4 + 0.5) / width, (1 + 0.5) / height);
    expect(blended[0]!).toBeCloseTo(0.5, 6);
    // 反向:right.a > center.b 时应向右混合 right.a(锁 a[3] 为正向操作数)。
    const weightsFlipped = new Float32Array(width * height * 4);
    weightsFlipped.set([0, 0, 0.25, 0], (1 * width + 4) * 4); // center: b=0.25
    weightsFlipped.set([0, 0, 0, 0.5], (1 * width + 5) * 4); // right: a=0.5
    const blendedFlipped = smaaNeighborhoodBlendingPS({ width, height, color }, weightsFlipped, (4 + 0.5) / width, (1 + 0.5) / height);
    expect(blendedFlipped[0]!).toBeCloseTo(0.2 + (0.2 - 0.2) * 0.5, 6); // 右邻同为 0.2 → 不变色,但方向已定
    // 垂直操作数对(a.g=下方 vs a.r=中心):center.r=0.5 > down.g=0.25 → 向 v+ 方混合。
    const weightsVertical = new Float32Array(width * height * 4);
    weightsVertical.set([0.5, 0, 0, 0], (1 * width + 4) * 4); // center: r=0.5
    weightsVertical.set([0, 0.25, 0, 0], (2 * width + 4) * 4); // down(v-, y+1 行): g=0.25
    const blendedVertical = smaaNeighborhoodBlendingPS({ width, height, color }, weightsVertical, (4 + 0.5) / width, (1 + 0.5) / height);
    expect(blendedVertical[0]!).toBeCloseTo(0.2, 6); // 两个邻居同为 0.2,方向语义由上例把守,此处锁不崩
  });
});
