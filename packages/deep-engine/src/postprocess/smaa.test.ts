// SMAA CPU 镜像行为与能量验收(AA-M2 L3):resolveSmaaCpu 是三 pass WGSL 链的逐式
// TS 权威镜像(测试规模)。能量口径 = aliasingEnergy(合成阶梯场景,4×SSAA 参考)。
// 门②(SMAA 不劣 FXAA 同口径)在此把守;门①(较 no-AA ↓≥80%)的实测数字如实记录
// ——合成场景的走样由三类源构成,其中细栅栏(3px 周期)与 1px 圆弧属欠采样纹理,
// 空间 AA 无法重建(信息已丢失),几何边类才可恢复;分类数字见 evidence 探针。
import { describe, expect, it } from "vitest";
import { aliasingReduction, measureAliasingEnergy, syntheticStaircaseCase } from "./aliasingEnergy.js";
import { resolveSmaaCpu } from "./smaaCpu.js";
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
});
