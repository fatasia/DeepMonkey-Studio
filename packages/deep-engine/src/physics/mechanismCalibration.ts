/**
 * D2 切片：解析机构链的可微标定（T23 标定辅助）。
 *
 * 范围与诚实声明：本切片提供曲柄滑块（T17 活塞-曲柄黄金同构）的闭式运动学、
 * 解析梯度（参数与曲柄角）与 Gauss-Newton 参数拟合；齿轮传动比作为线性特例纳入。
 * 不含：Rapier 仿真求导（物理仿真的梯度需可微物理引擎，明确排除）、通用
 * 自动微分、多关节泛化（列后续）。全部 f64、纯函数、零随机源——同输入逐位一致。
 *
 * 供 T23 使用的方式：参数拟合以"解析梯度 vs 有限差分"双通道互验，任何一通道
 * 不可用即失败，不降级猜测。目标是从带噪行程采样中恢复机构参数（r、l、偏置），
 * 为现场实测数据→机构参数的标定提供确定性内核。
 */

/** 曲柄滑块几何参数（米）。 */
export interface SliderCrankParams {
  /** 曲柄半径 r > 0。 */
  readonly r: number;
  /** 连杆长度 l > r（物理可装配约束）。 */
  readonly l: number;
  /** 活塞行程轴向偏置 x₀（米），活塞位置 = x(θ) + x₀。 */
  readonly offset: number;
}

export interface SliderCrankSample {
  /** 曲柄角（弧度）。 */
  readonly theta: number;
  /** 观测活塞位置（米）。 */
  readonly x: number;
}

/** 位置与解析梯度 ∂x/∂θ、∂x/∂r、∂x/∂l、∂x/∂offset。 */
export interface SliderCrankValueAndGradient {
  readonly x: number;
  readonly dxdTheta: number;
  readonly dxdR: number;
  readonly dxdL: number;
  readonly dxdOffset: number;
}

const assertFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`机构标定：${name} 必须为有限数值，实际 ${value}`);
  return value;
};

export const assertSliderCrankParams = (p: SliderCrankParams): void => {
  assertFinite(p.r, "r"); assertFinite(p.l, "l"); assertFinite(p.offset, "offset");
  if (p.r <= 0) throw new RangeError(`机构标定：曲柄半径必须 > 0，实际 ${p.r}`);
  if (p.l <= p.r) throw new RangeError(`机构标定：连杆长必须 > 曲柄半径（可装配），实际 l=${p.l} r=${p.r}`);
};

/** 闭式位置：x(θ) = r·cosθ + √(l² − r²sin²θ)。要求 sinθ 项在数值上不越过根号约束。 */
export function sliderCrankPosition(params: SliderCrankParams, theta: number): number {
  assertSliderCrankParams(params);
  assertFinite(theta, "theta");
  const rad2 = params.l * params.l - params.r * params.r * Math.sin(theta) * Math.sin(theta);
  if (rad2 <= 0) throw new RangeError(`机构标定：l²−r²sin²θ = ${rad2} ≤ 0，数值上违反可装配约束`);
  return params.r * Math.cos(theta) + Math.sqrt(rad2) + params.offset;
}

/** 位置与解析梯度；与 sliderCrankPosition 同式逐项求导，不使用数值近似。 */
export function sliderCrankValueAndGradient(params: SliderCrankParams, theta: number): SliderCrankValueAndGradient {
  assertSliderCrankParams(params);
  assertFinite(theta, "theta");
  const sin = Math.sin(theta), cos = Math.cos(theta);
  const root = Math.sqrt(params.l * params.l - params.r * params.r * sin * sin);
  if (!(root > 0)) throw new RangeError("机构标定：根号项非正，梯度无定义");
  const x = params.r * cos + root + params.offset;
  return Object.freeze({
    x,
    dxdTheta: -params.r * sin - (params.r * params.r * sin * cos) / root,
    dxdR: cos - (params.r * sin * sin) / root,
    dxdL: params.l / root,
    dxdOffset: 1,
  });
}

/** 中心差分核；步长按 f64 精度与量级选择（Hirundinidae 近似 h≈cbrt(ε)·scale）。 */
export function finiteDifferenceGradient(params: SliderCrankParams, theta: number,
  stepScale = 1): [number, number, number, number] {
  assertSliderCrankParams(params);
  if (!(stepScale > 0)) throw new RangeError("机构标定：差分步长尺度必须 > 0");
  const h = (name: keyof SliderCrankParams, scale: number): number =>
    Math.cbrt(Number.EPSILON) * Math.max(Math.abs(params[name]) * scale, 1);
  const base = sliderCrankPosition(params, theta);
  const dTheta = h("l", 1) * 4;
  const thetaPlus = sliderCrankPosition(params, theta + dTheta);
  const thetaMinus = sliderCrankPosition(params, theta - dTheta);
  const rPlus = sliderCrankPosition({ ...params, r: params.r + h("r", 1) }, theta);
  const rMinus = sliderCrankPosition({ ...params, r: params.r - h("r", 1) }, theta);
  const lPlus = sliderCrankPosition({ ...params, l: params.l + h("l", 1) }, theta);
  const lMinus = sliderCrankPosition({ ...params, l: params.l - h("l", 1) }, theta);
  const oPlus = sliderCrankPosition({ ...params, offset: params.offset + h("offset", 1) }, theta);
  const oMinus = sliderCrankPosition({ ...params, offset: params.offset - h("offset", 1) }, theta);
  void base;
  return [
    (thetaPlus - thetaMinus) / (2 * dTheta),
    (rPlus - rMinus) / (2 * h("r", 1)),
    (lPlus - lMinus) / (2 * h("l", 1)),
    (oPlus - oMinus) / (2 * h("offset", 1)),
  ].map(Math.fround) as [number, number, number, number];
}

/** Gauss-Newton 单次迭代：解 (JᵀJ)Δ = −Jᵀr 并返回新参数。方程数 ≥ 3，否则欠定拒绝。 */
export function gaussNewtonStep(params: SliderCrankParams, samples: readonly SliderCrankSample[]): SliderCrankParams {
  if (samples.length < 3) throw new RangeError(`机构标定：拟合至少需要 3 个样本，实际 ${samples.length}`);
  let jTj = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let jTr = [0, 0, 0];
  for (const sample of samples) {
    assertFinite(sample.theta, "sample.theta"); assertFinite(sample.x, "sample.x");
    const g = sliderCrankValueAndGradient(params, sample.theta);
    const residual = g.x - sample.x;
    const j = [g.dxdR, g.dxdL, g.dxdOffset];
    for (let row = 0; row < 3; row += 1) {
      jTr[row]! += j[row]! * residual;
      for (let col = 0; col < 3; col += 1) jTj[row * 3 + col]! += j[row]! * j[col]!;
    }
  }
  const delta = solve3(jTj, jTr);
  const next = { r: params.r - delta[0]!, l: params.l - delta[1]!, offset: params.offset - delta[2]! };
  assertSliderCrankParams(next);
  return next;
}

/** 拟合到收敛：最多 maxIterations 次 Gauss-Newton，残差平方和下降不足即停；返回最终参数与残差。 */
export function fitSliderCrank(initial: SliderCrankParams, samples: readonly SliderCrankSample[],
  maxIterations = 32, tolerance = 1e-12): { params: SliderCrankParams; residualSse: number; iterations: number } {
  assertSliderCrankParams(initial);
  let current = initial;
  let previousSse = Number.POSITIVE_INFINITY;
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    let sse = 0;
    for (const sample of samples) {
      const residual = sliderCrankPosition(current, sample.theta) - sample.x;
      sse += residual * residual;
    }
    if (previousSse - sse <= tolerance) return { params: current, residualSse: sse, iterations };
    previousSse = sse;
    current = gaussNewtonStep(current, samples);
  }
  let sse = 0;
  for (const sample of samples) {
    const residual = sliderCrankPosition(current, sample.theta) - sample.x;
    sse += residual * residual;
  }
  return { params: current, residualSse: sse, iterations };
}

/** 3×3 对称正定线性求解（CHOLESKY）；非正定即说明参数不可辨识，fail-closed。 */
function solve3(m: readonly number[], b: readonly number[]): [number, number, number] {
  const lower = [1, 0, 0, 0, 1, 0, 0, 0, 1].map(() => 0);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col <= row; col += 1) {
      let sum = m[row * 3 + col]!;
      for (let k = 0; k < col; k += 1) sum -= lower[row * 3 + k]! * lower[col * 3 + k]!;
      if (row === col) {
        if (!(sum > 0)) throw new Error("机构标定：JᵀJ 非正定，参数在该样本集下不可辨识");
        lower[row * 3 + col] = Math.sqrt(sum);
      } else lower[row * 3 + col] = sum / lower[col * 3 + col]!;
    }
  }
  const y = [0, 0, 0];
  for (let row = 0; row < 3; row += 1) {
    let sum = b[row]!;
    for (let k = 0; k < row; k += 1) sum -= lower[row * 3 + k]! * y[k]!;
    y[row] = sum / lower[row * 3 + row]!;
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let sum = y[row]!;
    for (let k = row + 1; k < 3; k += 1) sum -= lower[k * 3 + row]! * x[k]!;
    x[row] = sum / lower[row * 3 + row]!;
  }
  return [x[0]!, x[1]!, x[2]!];
}

/** 齿轮传动比（线性特例）：θ_out = θ_in·ratio。解析梯度即常数，供标定同一管道消费。 */
export function gearOutputAngle(thetaIn: number, ratio: number): number {
  assertFinite(thetaIn, "thetaIn");
  if (!Number.isFinite(ratio) || ratio === 0) throw new RangeError(`机构标定：齿轮传动比必须为非零有限值，实际 ${ratio}`);
  return thetaIn * ratio;
}
