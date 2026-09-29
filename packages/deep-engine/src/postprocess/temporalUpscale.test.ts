import { describe, expect, it } from "vitest";
import { catmullRomWeights, internalRenderSize, resolveTemporalUpscaleCpu,
  temporalUpscaleActive, validateTemporalUpscaleCpuInput } from "./temporalUpscaleCpu.js";
import { packTemporalUpscaleParameters } from "./temporalUpscale.js";
import type { TemporalUpscaleCpuInput } from "./temporalUpscaleTypes.js";

const OPTIONS = Object.freeze({ feedback: 0.9, depthThreshold: 0.05, relativeDepthThreshold: 0.02 });

/** RGB 三通道 MSE(alpha 常量通道对画质无信息,不稀释比值)。 */
const mse = (a: readonly number[], b: readonly number[]): number => {
  let sum = 0, count = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i]; sum += d * d; count++;
  }
  return sum / count;
};

const psnr = (a: readonly number[], b: readonly number[]): number => mse(a, b) <= 1e-12 ? Infinity : 10 * Math.log10(1 / mse(a, b));

/** 解析内容场:光滑多周期正弦(周期 8 显示像素,内部 4 texel/周期),真值在任意连续坐标可求。 */
const content = (x: number, y: number): number => 0.5 + 0.5 * Math.sin(2 * Math.PI * 6 * x / 48) * Math.cos(2 * Math.PI * 6 * y / 36);

interface Field { displayWidth: number; displayHeight: number; scale: number }

/** 在显示坐标 (x, y) 以帧偏移 offset 采样内容,返回 RGBA。 */
const sampleContent = (field: Field, x: number, y: number, offsetX: number): readonly [number, number, number, number] => {
  const value = content(x - offsetX, y);
  return [value, value * 0.5, 1 - value, 1];
};

function syntheticInput(field: Field, offset: number, motionScale = 1): {
  input: TemporalUpscaleCpuInput; groundTruth: Float32Array;
} {
  const internalWidth = Math.max(1, Math.floor(field.displayWidth * field.scale));
  const internalHeight = Math.max(1, Math.floor(field.displayHeight * field.scale));
  const color = new Array<number>(internalWidth * internalHeight * 4);
  const depth = new Array<number>(internalWidth * internalHeight);
  const motion = new Array<number>(internalWidth * internalHeight * 2);
  // 内部像素渲染内容(偏移随帧);深度恒定(平面场景);运动 = 帧间显示域平移的 UV 场。
  for (let y = 0; y < internalHeight; y++) for (let x = 0; x < internalWidth; x++) {
    const texel = y * internalWidth + x;
    const [r, g, b, a] = sampleContent(field, (x + 0.5) / field.scale, (y + 0.5) / field.scale, offset);
    color[texel * 4] = r; color[texel * 4 + 1] = g; color[texel * 4 + 2] = b; color[texel * 4 + 3] = a;
    depth[texel] = 4;
    // current-to-previous-UV:同一物点上一帧在显示域 (p - offset) 处 → motion·size = -offset。
    motion[texel * 2] = -offset * motionScale / field.displayWidth;
    motion[texel * 2 + 1] = 0;
  }
  const groundTruth = new Float32Array(field.displayWidth * field.displayHeight * 4);
  for (let y = 0; y < field.displayHeight; y++) for (let x = 0; x < field.displayWidth; x++) {
    groundTruth.set([...sampleContent(field, x + 0.5, y + 0.5, offset)], (y * field.displayWidth + x) * 4);
  }
  return { input: {
    displayWidth: field.displayWidth, displayHeight: field.displayHeight, scale: field.scale,
    color, depth, motion, currentJitter: [0, 0], previousJitter: [0, 0], historyValid: false,
  }, groundTruth };
}

const FIELD = { displayWidth: 48, displayHeight: 36, scale: 0.75 } as const;

describe("catmullRomWeights", () => {
  it("weights sum to one across the fraction range and match the kernel values", () => {
    for (let i = 0; i < 16; i++) {
      const fraction = i / 16;
      const weights = catmullRomWeights(fraction);
      const sum = weights.reduce((total, weight) => total + weight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
    }
    expect(catmullRomWeights(0)).toEqual([0, 1, 0, 0]);
  });

  it("is symmetric around the texel centers", () => {
    expect(catmullRomWeights(0.25)).toEqual(catmullRomWeights(0.75).slice().reverse() as unknown as readonly [number, number, number, number]);
    expect(() => catmullRomWeights(1)).toThrow();
    expect(() => catmullRomWeights(-0.1)).toThrow();
    expect(() => catmullRomWeights(Number.NaN)).toThrow();
  });
});

describe("temporalUpscaleActive", () => {
  it("gates the pass on the feature flag and an actual downscale", () => {
    expect(temporalUpscaleActive(false, 0.67)).toBe(false);
    expect(temporalUpscaleActive(true, 1)).toBe(false);
    expect(temporalUpscaleActive(true, 0.67)).toBe(true);
    expect(temporalUpscaleActive(true, 0.5)).toBe(true);
    expect(() => temporalUpscaleActive(true, 0)).toThrow();
    expect(() => temporalUpscaleActive(true, 1.2)).toThrow();
    expect(() => temporalUpscaleActive(true, Number.NaN)).toThrow();
    expect(() => temporalUpscaleActive("on" as unknown as boolean, 0.67)).toThrow(TypeError);
  });
});

describe("internalRenderSize", () => {
  it("floors the surface by scale with a floor of one and is identity at scale 1", () => {
    expect(internalRenderSize({ width: 1920, height: 1080 }, 0.67)).toEqual({ width: 1286, height: 723 });
    expect(internalRenderSize({ width: 3, height: 3 }, 0.1)).toEqual({ width: 1, height: 1 });
    const surface = { width: 800, height: 600 };
    expect(internalRenderSize(surface, 1)).toBe(surface);
    expect(() => internalRenderSize({ width: 0, height: 10 }, 0.5)).toThrow();
    expect(() => internalRenderSize({ width: 10, height: 10 }, 1.5)).toThrow();
  });
});

describe("packTemporalUpscaleParameters", () => {
  it("matches the WGSL UpscaleParams layout field by field", () => {
    const buffer = packTemporalUpscaleParameters(
      { displayWidth: 1920, displayHeight: 1080, internalWidth: 1286, internalHeight: 723 },
      true, [0.25, -0.25], [0, 0], OPTIONS, false);
    const uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
    expect([...uints.slice(0, 4)]).toEqual([1920, 1080, 1286, 723]);
    expect(uints[4]).toBe(1);
    expect(uints[5]).toBe(0);
    expect(floats[8]).toBeCloseTo(OPTIONS.feedback);
    expect(floats[9]).toBeCloseTo(OPTIONS.depthThreshold);
    expect(floats[10]).toBeCloseTo(OPTIONS.relativeDepthThreshold);
    expect(floats[11]).toBeCloseTo(1920 / 1286);
    expect(floats[12]).toBeCloseTo((0 - 0.25) * (1920 / 1286));
    expect(floats[13]).toBeCloseTo((0 - -0.25) * (1920 / 1286));
    const invalid = packTemporalUpscaleParameters(
      { displayWidth: 64, displayHeight: 64, internalWidth: 32, internalHeight: 32 }, false, [0, 0], [0, 0], OPTIONS, false);
    expect(new Uint32Array(invalid)[4]).toBe(0);
    // reactive 门位:供给 mask 时 flags.y = 1(其余 flags 位保持零)。
    const reactive = packTemporalUpscaleParameters(
      { displayWidth: 64, displayHeight: 64, internalWidth: 32, internalHeight: 32 }, true, [0, 0], [0, 0], OPTIONS, true);
    const reactiveFlags = new Uint32Array(reactive).slice(4, 8);
    expect([...reactiveFlags]).toEqual([1, 1, 0, 0]);
  });
});

describe("validateTemporalUpscaleCpuInput", () => {
  it("rejects buffer length mismatch, negative depth, and out-of-range jitter", () => {
    const { input } = syntheticInput(FIELD, 0);
    expect(() => validateTemporalUpscaleCpuInput(input)).not.toThrow();
    expect(() => validateTemporalUpscaleCpuInput({ ...input, color: input.color.slice(0, 8) })).toThrow();
    const badDepth = input.depth.slice();
    badDepth[0] = -1;
    expect(() => validateTemporalUpscaleCpuInput({ ...input, depth: badDepth })).toThrow();
    expect(() => validateTemporalUpscaleCpuInput({ ...input, currentJitter: [1, 0] })).toThrow();
    expect(() => validateTemporalUpscaleCpuInput({ ...input, historyValid: true })).toThrow();
    // reactive alpha:内部分辨率长度 + [0,1] 值域 fail-closed。
    expect(() => validateTemporalUpscaleCpuInput({ ...input, reactiveAlpha: [0, 1] })).toThrow();
    const outOfRange = new Array<number>(input.depth.length).fill(0);
    outOfRange[3] = 1.5;
    expect(() => validateTemporalUpscaleCpuInput({ ...input, reactiveAlpha: outOfRange })).toThrow();
    expect(() => validateTemporalUpscaleCpuInput({ ...input, reactiveAlpha: new Array<number>(input.depth.length).fill(0.25) }))
      .not.toThrow();
    const valid = syntheticInput(FIELD, 0);
    const history = new Float32Array(FIELD.displayWidth * FIELD.displayHeight * 4).fill(0.5);
    const historyDepth = new Float32Array(FIELD.displayWidth * FIELD.displayHeight).fill(4);
    expect(() => validateTemporalUpscaleCpuInput({ ...valid.input, historyValid: true,
      previousColor: history, previousDepth: historyDepth })).not.toThrow();
  });
});

describe("resolveTemporalUpscaleCpu", () => {
  it("degrades bit-identically to the pure spatial kernel when history is invalid", () => {
    const { input, groundTruth } = syntheticInput(FIELD, 0);
    const baseline = resolveTemporalUpscaleCpu(input, OPTIONS);
    const garbageHistory = new Float32Array(FIELD.displayWidth * FIELD.displayHeight * 4).fill(7);
    const withGarbage = resolveTemporalUpscaleCpu({ ...input, historyValid: false,
      previousColor: garbageHistory, previousDepth: new Float32Array(FIELD.displayWidth * FIELD.displayHeight).fill(4) }, OPTIONS);
    expect([...withGarbage]).toEqual([...baseline]);
    // 失效帧与真值的差距就是空间核的逼近误差;光滑场上应显著优于零。
    expect(mse(baseline, groundTruth)).toBeGreaterThan(0);
  });

  it("beats bilinear upsampling on the smooth analytic field (spatial kernel quality gate)", () => {
    const { input, groundTruth } = syntheticInput(FIELD, 0);
    const output = resolveTemporalUpscaleCpu(input, OPTIONS);
    // 双线性参考(手写,同显示尺寸):验证 Catmull-Rom 在光滑场上的可测量优势。
    const internalWidth = Math.max(1, Math.floor(FIELD.displayWidth * FIELD.scale));
    const internalHeight = Math.max(1, Math.floor(FIELD.displayHeight * FIELD.scale));
    const bilinear = new Float32Array(groundTruth.length);
    for (let y = 0; y < FIELD.displayHeight; y++) for (let x = 0; x < FIELD.displayWidth; x++) {
      const px = (x + 0.5) / FIELD.displayWidth * internalWidth - 0.5;
      const py = (y + 0.5) / FIELD.displayHeight * internalHeight - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const fx = px - x0, fy = py - y0;
      const out = (y * FIELD.displayWidth + x) * 4;
      for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
        const sx = Math.min(internalWidth - 1, Math.max(0, x0 + tx));
        const sy = Math.min(internalHeight - 1, Math.max(0, y0 + ty));
        const weight = (tx === 0 ? 1 - fx : fx) * (ty === 0 ? 1 - fy : fy);
        for (let channel = 0; channel < 4; channel++) {
          bilinear[out + channel] += input.color[(sy * internalWidth + sx) * 4 + channel] * weight;
        }
      }
    }
    const catmullRomMse = mse(output, groundTruth);
    const bilinearMse = mse(bilinear, groundTruth);
    expect(bilinearMse).toBeGreaterThan(catmullRomMse);
    // 物理门:光滑场 2× 放大上,Catmull-Rom 相对双线性的 PSNR 增益 ≥1.5 dB。
    expect(psnr(output, groundTruth) - psnr(bilinear, groundTruth)).toBeGreaterThanOrEqual(1.5);
  });

  it("recovers moving fine structure through temporal accumulation beyond the spatial kernel", () => {
    // 高频条带(奈奎斯特附近,静止内部采样欠采样)+ 每帧 2 显示像素平移:
    // 时域重投影从历史取回真实相位,收敛帧 MSE 须低于失效帧(纯空间核)基线。
    const field = { displayWidth: 48, displayHeight: 24, scale: 0.5 } as const;
    const stripe = (x: number): number => (Math.floor(x / 1.5) % 2 === 0 ? 0.9 : 0.1);
    const internalWidth = Math.floor(field.displayWidth * field.scale);
    const internalHeight = Math.floor(field.displayHeight * field.scale);
    const build = (offset: number): TemporalUpscaleCpuInput => {
      const color: number[] = [], motion: number[] = [], depth: number[] = [];
      for (let y = 0; y < internalHeight; y++) for (let x = 0; x < internalWidth; x++) {
        const value = stripe((x + 0.5) / field.scale - offset);
        color.push(value, value, value, 1);
        depth.push(4);
        motion.push(-2 / field.displayWidth * field.scale, 0);
      }
      return { displayWidth: field.displayWidth, displayHeight: field.displayHeight, scale: field.scale,
        color, depth, motion, currentJitter: [0, 0], previousJitter: [0, 0], historyValid: false };
    };
    const truth = new Float32Array(field.displayWidth * field.displayHeight * 4);
    for (let y = 0; y < field.displayHeight; y++) for (let x = 0; x < field.displayWidth; x++) {
      const value = stripe(x - 4);
      truth.set([value, value, value, 1], (y * field.displayWidth + x) * 4);
    }
    const frame0 = resolveTemporalUpscaleCpu(build(4), OPTIONS);
    const baselineMse = mse(frame0, truth);
    expect(baselineMse).toBeGreaterThan(0);
    // 帧 1:历史 = 帧 0 输出,motion 指向 (p - 2) 处的帧 0 显示像素,内容连续。
    const frame1Input = build(6);
    frame1Input.historyValid = true;
    frame1Input.previousColor = frame0;
    frame1Input.previousDepth = new Float32Array(field.displayWidth * field.displayHeight).fill(4);
    const frame1 = resolveTemporalUpscaleCpu(frame1Input, OPTIONS);
    const frame1Mse = mse(frame1, truth);
    expect(frame1Mse).toBeLessThan(baselineMse);
  });

  it("rejects a wrong-direction motion field instead of trusting it (ghost guard)", () => {
    // 运动矢量反向:重投影落到内容突变区,深度恒定时依赖 YCoCg 钳制兜底;
    // 断言输出不发散(误差有界),而不是与正确运动一样好。
    const { input, groundTruth } = syntheticInput(FIELD, 4);
    const history = new Float32Array(FIELD.displayWidth * FIELD.displayHeight * 4);
    for (let y = 0; y < FIELD.displayHeight; y++) for (let x = 0; x < FIELD.displayWidth; x++) {
      history.set([...sampleContent(FIELD, x, y, 0)], (y * FIELD.displayWidth + x) * 4);
    }
    const flipped = { ...input, historyValid: true, previousColor: history,
      previousDepth: new Float32Array(FIELD.displayWidth * FIELD.displayHeight).fill(4),
      motion: input.motion.map(value => -value) };
    const output = resolveTemporalUpscaleCpu(flipped, OPTIONS);
    const raw = [...output];
    expect(raw.every(Number.isFinite)).toBe(true);
    expect(raw.every(value => value >= 0)).toBe(true);
    // 有界劣化:反向运动输出仍优于把陈旧历史全盘信任(直接输出历史)的极端。
    expect(mse(output, groundTruth)).toBeLessThan(mse(history, groundTruth));
  });

  it("honors the feedback value and depth-aware rejection thresholds", () => {
    const { input } = syntheticInput(FIELD, 0);
    const history = new Float32Array(FIELD.displayWidth * FIELD.displayHeight * 4).fill(0.5);
    const withHistory = { ...input, historyValid: true, previousColor: history,
      previousDepth: new Float32Array(FIELD.displayWidth * FIELD.displayHeight).fill(4) };
    const fullCurrent = resolveTemporalUpscaleCpu(withHistory, { ...OPTIONS, feedback: 0 });
    const baseline = resolveTemporalUpscaleCpu(input, OPTIONS);
    expect([...fullCurrent]).toEqual([...baseline]);
    const half = resolveTemporalUpscaleCpu(withHistory, { ...OPTIONS, feedback: 0.5 });
    expect(mse(half, history)).toBeGreaterThan(0);
    expect(() => resolveTemporalUpscaleCpu(withHistory, { ...OPTIONS, feedback: 1 })).toThrow();
    expect(() => resolveTemporalUpscaleCpu(input, { ...OPTIONS, depthThreshold: -1 })).toThrow();
  });

  describe("reactive coverage (T07 per-pixel mask supply)", () => {
    /** 常量历史(0.5)+ 正弦当前场:时域项普遍生效,reactive 的影响可观测。 */
    function withConstantHistory() {
      const { input } = syntheticInput(FIELD, 0);
      const history = new Float32Array(FIELD.displayWidth * FIELD.displayHeight * 4).fill(0.5);
      return { input: { ...input, historyValid: true, previousColor: history,
        previousDepth: new Float32Array(FIELD.displayWidth * FIELD.displayHeight).fill(4) }, history };
    }
    const distToHistory = (output: Float32Array, history: Float32Array): number => mse(output, [...history]);

    it("keeps the no-supply output bit-identical to the all-zero mask (zero behavior change)", () => {
      const { input, history } = withConstantHistory();
      const baseline = resolveTemporalUpscaleCpu(input, OPTIONS);
      const zeroMask = resolveTemporalUpscaleCpu({ ...input,
        reactiveAlpha: new Array<number>(input.depth.length).fill(0) }, OPTIONS);
      expect([...zeroMask]).toEqual([...baseline]);
      expect(distToHistory(baseline, history)).toBeGreaterThan(0);
    });

    it("downweights history to the pure spatial kernel wherever the mask is non-zero", () => {
      const { input } = withConstantHistory();
      const spatialOnly = resolveTemporalUpscaleCpu({ ...input, historyValid: false,
        previousColor: undefined, previousDepth: undefined }, OPTIONS);
      const fullMask = resolveTemporalUpscaleCpu({ ...input,
        reactiveAlpha: new Array<number>(input.depth.length).fill(1) }, OPTIONS);
      // reactive = 1 → 历史权重归零,该帧输出与历史失效帧逐位一致(fail-closed 语义)。
      expect([...fullMask]).toEqual([...spatialOnly]);
    });

    it("scales the remaining history contribution monotonically with the reactive value", () => {
      const { input, history } = withConstantHistory();
      const outputs = [0, 0.5, 1].map(value => resolveTemporalUpscaleCpu({ ...input,
        reactiveAlpha: new Array<number>(input.depth.length).fill(value) }, OPTIONS));
      const distances = outputs.map(output => distToHistory(output, history));
      // 历史贡献随 reactive 单调衰减:reactive 越高越不信任历史。
      expect(distances[2]).toBeGreaterThan(distances[1]);
      expect(distances[1]).toBeGreaterThan(distances[0]);
    });
  });
});
