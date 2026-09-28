/**
 * T20 切片:粒子属性曲线求值器(线性 / 关键帧插值)。
 *
 * 确定性口径:f64 纯函数,无随机、无时钟;同输入逐位同输出。非法输入(非有限值、
 * 时间非严格递增)抛错,绝不静默钳制出 NaN。GPU 侧消费(渲染 WGSL 读取关键帧纹理)
 * 留联测,本文件是统计与 CPU 路径的唯一公式源。
 */

export interface ParticleCurveKeyframe {
  readonly time: number;
  readonly value: number;
}
/** 单调关键帧序列;单帧即常量曲线。 */
export type ParticleCurve = readonly ParticleCurveKeyframe[];

export interface ParticleCurveEvaluation {
  readonly value: number;
  readonly segment: number;
  readonly clamped: boolean;
}

function finite(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${name} must be finite.`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  const checked = finite(value, name);
  if (checked < 0) throw new RangeError(`${name} must be non-negative.`);
  return checked;
}

/** 校验并冻结关键帧;时间必须严格递增,值必须有限。 */
export function createParticleCurve(keyframes: readonly ParticleCurveKeyframe[], name: string): ParticleCurve {
  if (!Array.isArray(keyframes) || keyframes.length < 1 || keyframes.length > 256) {
    throw new TypeError(`${name} must contain between 1 and 256 keyframes.`);
  }
  let previous = -1;
  const frames = keyframes.map((frame, index) => {
    if (!frame || typeof frame !== "object") throw new TypeError(`${name}[${index}] is invalid.`);
    const time = nonNegative(frame.time, `${name}[${index}].time`);
    const value = finite(frame.value, `${name}[${index}].value`);
    if (time <= previous) throw new RangeError(`${name} times must be strictly increasing.`);
    previous = time;
    return Object.freeze({ time, value });
  });
  return Object.freeze(frames);
}

/** 常量曲线构造(尺寸 / 不透明度等不随生命变化的量)。 */
export function createConstantParticleCurve(value: number, name: string): ParticleCurve {
  return createParticleCurve([{ time: 0, value }], name);
}

/** 线性插值;越界端点钳制并标记 clamped(确定性分支,无 NaN 路径)。 */
export function evaluateParticleCurve(curve: ParticleCurve, time: number): ParticleCurveEvaluation {
  if (!Array.isArray(curve) || curve.length < 1) throw new TypeError("Particle curve is invalid.");
  const t = finite(time, "time");
  const first = curve[0]!, last = curve[curve.length - 1]!;
  if (t <= first.time) {
    return Object.freeze({ value: first.value, segment: 0, clamped: t < first.time });
  }
  if (t >= last.time) {
    return Object.freeze({ value: last.value, segment: curve.length - 2, clamped: t > last.time });
  }
  let upper = 1;
  while (upper < curve.length && curve[upper]!.time < t) upper++;
  const before = curve[upper - 1]!, after = curve[upper]!;
  const span = after.time - before.time;
  const alpha = span > 0 ? (t - before.time) / span : 0;
  return Object.freeze({ value: before.value + (after.value - before.value) * alpha,
    segment: upper - 1, clamped: false });
}

/** 按生命周期归一求值:t = clamp(age / lifetime, 0, 1)。 */
export function evaluateParticleCurveOverLife(curve: ParticleCurve, age: number, lifetime: number): number {
  const clampedAge = nonNegative(age, "age");
  const clampedLifetime = finite(lifetime, "lifetime");
  if (clampedLifetime <= 0) throw new RangeError("lifetime must be positive.");
  return evaluateParticleCurve(curve, clampedAge / clampedLifetime).value;
}

/** 对一组归一化采样点取曲线均值(统计用,确定性遍历顺序)。 */
export function meanParticleCurveValue(curve: ParticleCurve, samples: number): number {
  const count = Math.floor(samples);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_048_576) {
    throw new RangeError("samples must be an integer in 1..1048576.");
  }
  let total = 0;
  for (let index = 0; index < count; index++) {
    total += evaluateParticleCurve(curve, index / (count - 1)).value;
  }
  return total / count;
}
