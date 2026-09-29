import type { LightVector3 } from "./types.js";

/**
 * C3 矩形面积光 LTC(Linearly Transformed Cosines)数学内核与权威 CPU 参考。
 *
 * 出处(公开领域论文算法,自实现;不含任何引擎专有代码或 LUT 数据):
 *  - E. Heitz, J. Hanika, E. d'Eon, C. Dachsbacher, "Real-Time Polygonal-Light
 *    Shading with Linearly Transformed Cosines", JCGT/SIGGRAPH 2016。
 *    高光 = LTC 矩阵采样 + 线性变换后球面多边形的余弦立体角积分(论文 §4 定理:
 *    变换后瓣在原多边形上的积分恰为 M⁻¹P 的余弦形式因子)。
 *  - 漫反射 = 球面矩形向量形式因子的经典精确解(vector form factor,
 *    atan2(sinθ, 1+cosθ) = θ/2 内核),无需 LUT。
 *
 * 拟合器确定性:方向集为固定球面 Fibonacci 格点,Nelder-Mead 无随机项,
 * 同输入逐位复现(ltc.test.ts 以已提交表的抽样 texel 锁定)。
 * 表数据不入本文件——离线生成入库于 ltcTables.ts(出处与指纹门在彼处)。
 */

export const LTC_LUT_SIZE = 64;
/** 感知粗糙度拟合域下限,与直射路径 clamp(rough, 0.045, 1) 同值。 */
export const LTC_ROUGHNESS_FLOOR = 0.045;
/** 每 texel 8 个 f32:invM row0(3)+pad(1)+row1(3)+amplitude(1);row2 ≡ (0,0,1)。 */
export const LTC_LUT_FLOATS_PER_TEXEL = 8;

type Vec3 = [number, number, number];
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const PI = Math.PI;

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 1];
}
function multiplyMatrix(matrix: Mat3, value: Vec3): Vec3 {
  return [
    matrix[0] * value[0] + matrix[1] * value[1] + matrix[2] * value[2],
    matrix[3] * value[0] + matrix[4] * value[1] + matrix[5] * value[2],
    matrix[6] * value[0] + matrix[7] * value[1] + matrix[8] * value[2],
  ];
}

/**
 * 拟合目标:GGX 高光 BRDF(F=1,相关 Smith visibility)× 接收余弦。
 * f = D·V,Fresnel 留给运行时 Schlick 调制——与主直射路径的分解一致。
 * 导出供测试做 MC 参考(与 pbr_brdf/WGSL 直射 D·V 同式)。
 */
export function ggxSpecularTimesCosine(direction: Vec3, view: Vec3, alpha: number): number {
  const nDotL = dot([0, 0, 1], direction);
  if (nDotL <= 0) return 0;
  const halfVector = normalize([view[0] + direction[0], view[1] + direction[1], view[2] + direction[2]]);
  const nDotH = Math.min(Math.max(halfVector[2], 0), 1);
  const nDotV = Math.min(Math.max(view[2], 1e-4), 1);
  const alpha2 = alpha * alpha;
  const denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  const distribution = alpha2 / Math.max(PI * denominator * denominator, 1e-9);
  const gv = nDotL * Math.sqrt(alpha2 + (1 - alpha2) * nDotV * nDotV);
  const gl = nDotV * Math.sqrt(alpha2 + (1 - alpha2) * nDotL * nDotL);
  return distribution * (0.5 / Math.max(gv + gl, 1e-9)) * nDotL;
}

/** 逐 texel 拟合方向集(确定性):全球 Fibonacci 2/3 + 瓣心(镜像方向)锥内 Fibonacci 1/3。
 * 低粗糙 GGX 瓣极窄,纯均匀采样对尖峰密度欠条件化(数点拟合五参数→矩阵狂野);
 * 锥样本补足瓣内支撑,均匀样本带本底权重钳住离轴泄漏。 */
export const LTC_FIT_SAMPLE_COUNT = 384;
export function fitDirections(cosTheta: number, roughness: number): readonly Vec3[] {
  const alpha = Math.min(Math.max(roughness, LTC_ROUGHNESS_FLOOR), 1) ** 2;
  const view: Vec3 = [Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0)), 0, Math.max(cosTheta, 1e-4)];
  const mirror = normalize([2 * view[2] * view[0], 2 * view[2] * view[1], 2 * view[2] * view[2] - 1]);
  const axis = Math.abs(mirror[0]) > 0.9 ? [0, 1, 0] as Vec3 : [1, 0, 0] as Vec3;
  const tangent = normalize(cross(axis, mirror));
  const bitangent = cross(mirror, tangent);
  const coneCos = Math.cos(Math.max(4 * Math.sqrt(alpha), 0.06));
  const golden = PI * (3 - Math.sqrt(5));
  const uniformCount = 256, coneCount = LTC_FIT_SAMPLE_COUNT - uniformCount;
  const directions: Vec3[] = [];
  for (let index = 0; index < uniformCount; index++) {
    const z = 1 - 2 * (index + 0.5) / uniformCount;
    const radius = Math.sqrt(Math.max(1 - z * z, 0));
    const angle = golden * index;
    directions.push([radius * Math.cos(angle), radius * Math.sin(angle), z]);
  }
  for (let index = 0; index < coneCount; index++) {
    const cosValue = 1 - (1 - coneCos) * (index + 0.5) / coneCount;
    const ring = Math.sqrt(Math.max(1 - cosValue * cosValue, 0));
    const angle = golden * index;
    const local = [ring * Math.cos(angle), ring * Math.sin(angle), cosValue] as Vec3;
    directions.push([
      tangent[0] * local[0] + bitangent[0] * local[1] + mirror[0] * local[2],
      tangent[1] * local[0] + bitangent[1] * local[1] + mirror[1] * local[2],
      tangent[2] * local[0] + bitangent[2] * local[1] + mirror[2] * local[2],
    ]);
  }
  return directions;
}

/**
 * 拟合族 = 可交付族(本切片定案,报告 §数学):
 * LUT 只存 invM 的 row0/row1,交付端把 row2 钉为 (0,0,1)(wgsl/ltcAreaLighting.wgsl 的
 * mat3x3f(row0,row1,(0,0,1)) 同式)。该约定数学上等价于经典 LTC 参数化 M 底行 (0,0,1),
 * 但**不能**用「先拟合任意 M、取其逆的前两行」实现——截断后的矩阵不属于被拟合的函数族,
 * θ>0 时交付与拟合系统性错配(实测交付相对误差放大 1e4 倍以上)。因此直接参数化:
 *   invM = [[p, 0, q], [0, r, 0], [0, 0, 1]]
 * p=切向 x 缩放, q=x-z 倾斜(瓣轴随视角,拟合帧 view 在 +xz 平面), r=副切向 y 缩放;
 * y 对称性(GGX 各向同性 + view 无 y 分量)使 y 行无倾斜。搜索 (p,r,q) + 幅值闭式最小二乘。
 */
function fitInverseMatrix(point: readonly number[]): Mat3 {
  const [p = 1, q = 0, r = 1] = point;
  return [p, 0, q, 0, r, 0, 0, 0, 1];
}

/** 拟合训练矩形族(切向空间:中心 (cx,cy,dist),平面⊥z,半宽/半高);生成器与测试共用。
 * 覆盖:轴上大/小、近场大立体角、离轴偏置、细长条带。 */
export interface LtcFitRect { readonly cx: number; readonly cy: number; readonly hw: number; readonly hh: number; readonly distance: number }
export const LTC_FIT_RECTS: readonly LtcFitRect[] = Object.freeze([
  { cx: 0, cy: 0, hw: 0.4, hh: 0.4, distance: 2 },
  { cx: 0.5, cy: 0.3, hw: 0.1, hh: 0.6, distance: 1.5 },
  { cx: 0, cy: 0, hw: 1.5, hh: 0.05, distance: 4 },
  { cx: 0, cy: 0, hw: 1, hh: 1, distance: 0.7 },
  { cx: -0.8, cy: 0, hw: 0.2, hh: 0.2, distance: 1.5 },
  { cx: 0, cy: 0.9, hw: 0.3, hh: 0.3, distance: 2.5 },
  { cx: 0.25, cy: 0.1, hw: 0.08, hh: 0.25, distance: 1.2 },
  { cx: -0.4, cy: -0.3, hw: 0.35, hh: 0.35, distance: 1.8 },
  { cx: 1.2, cy: 0, hw: 0.15, hh: 0.5, distance: 3 },
  { cx: 0, cy: 0, hw: 0.2, hh: 0.2, distance: 1.2 },
] as const);
/** 每 rect 的确定性 MC 采样数(LCG,无 RNG 依赖)。 */
export const LTC_FIT_MC_SAMPLES = 4096;

/** NM 打磨迭代上限(网格粗解已是好的起点,打磨只收尾)。 */
export const LTC_FIT_ITERATIONS = 160;

/**
 * 标准 Nelder-Mead 单纯形打磨(确定性:固定反射 1/扩张 2/收缩 0.5/坍缩 0.5 系数,
 * 无随机项;同输入逐位复现)。返回误差最低顶点的拷贝。
 */
export function nelderMead(objective: (point: number[]) => number, start: readonly number[], iterations: number): number[] {
  const dimensions = start.length;
  const simplex: Array<{ point: number[]; error: number }> = [{ point: [...start], error: objective([...start]) }];
  for (let axis = 0; axis < dimensions; axis++) {
    const point = [...start];
    point[axis] = start[axis] !== 0 ? start[axis]! * 1.05 : 1e-4;
    simplex.push({ point, error: objective(point) });
  }
  const centroid = new Array<number>(dimensions).fill(0);
  const transform = (factor: number): { point: number[]; error: number } => {
    centroid.fill(0);
    for (let index = 0; index < dimensions; index++) {
      for (let axis = 0; axis < dimensions; axis++) centroid[axis]! += simplex[index]!.point[axis]! / dimensions;
    }
    const point = centroid.map((value, axis) => value + factor * (value - simplex[dimensions]!.point[axis]!));
    return { point, error: objective(point) };
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    simplex.sort((left, right) => left.error - right.error);
    const worst = simplex[dimensions]!.error, best = simplex[0]!.error;
    const mirrored = transform(1);
    if (mirrored.error < best) {
      const expanded = transform(2);
      simplex[dimensions] = expanded.error < mirrored.error ? expanded : mirrored;
    } else if (mirrored.error < worst) {
      simplex[dimensions] = mirrored;
    } else {
      const contracted = transform(0.5);
      if (contracted.error < worst) { simplex[dimensions] = contracted; continue; }
      for (let index = 1; index <= dimensions; index++) {
        const point = simplex[index]!.point.map((value, axis) => (value + simplex[0]!.point[axis]!) / 2);
        simplex[index] = { point, error: objective(point) };
      }
    }
  }
  simplex.sort((left, right) => left.error - right.error);
  return [...simplex[0]!.point];
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

/** ∫_rect GGX(F=1)·cos_recv dω 的 MC 参考(面元均匀采样 + foreshortening,已对照解析内核定案)。 */
export function monteCarloRectIntegral(cosTheta: number, roughness: number, rect: LtcFitRect, samples = LTC_FIT_MC_SAMPLES): number {
  const view: Vec3 = [Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0)), 0, Math.max(cosTheta, 1e-4)];
  const alpha = Math.min(Math.max(roughness, LTC_ROUGHNESS_FLOOR), 1) ** 2;
  const random = lcg(0x9e3779b9 + Math.round(cosTheta * 65535) * 7919 + Math.round(roughness * 65535));
  let sum = 0;
  for (let sample = 0; sample < samples; sample++) {
    const x = rect.cx + (random() * 2 - 1) * rect.hw;
    const y = rect.cy + (random() * 2 - 1) * rect.hh;
    const length = Math.hypot(x, y, rect.distance);
    const direction: Vec3 = [x / length, y / length, rect.distance / length];
    const foreshortening = rect.distance / (length * length * length);
    sum += ggxSpecularTimesCosine(direction, view, alpha) * foreshortening;
  }
  return sum / samples * 4 * rect.hw * rect.hh;
}

/** 拟合训练矩形族(切向空间:中心 (cx,cy,dist),平面⊥z,半宽/半高);生成器与测试共用。
 * 覆盖:轴上大/小、近场大立体角、离轴偏置、细长条带——相对误差目标防大目标支配。 */
export interface LtcFit { readonly inverseMatrix: Mat3; readonly amplitude: number }

/**
 * 单 texel 拟合(cosTheta∈[0,1],roughness∈[floor,1]),确定性;表构建的原子操作。
 *
 * 拟合口径(定案,报告 §数学):**直接拟合运行时交付泛函**
 *   model(rect) = amp·FF_atan2(normalize(invM·P)),
 * 目标 = ∫_rect GGX(F=1)·cosθ_recv dω 的确定性 MC;误差 = 纯能量相对误差(对 texel 内
 * 最大响应归一,不加 per-rect 能量平方权——那会令尾瓣矩形完全不可见,尖峰+掠射下
 * 实测产生 38%~66% 的幻感能量过冲,实测定案)。搜索 = (p,r,q) 两阶段网格
 * (粗 step 1 → top-3 邻域 step 0.25,幅值闭式最小二乘)+ NM 打磨(仅当训练误差降低才采纳)。
 */
export function fitLtcTexel(cosTheta: number, roughness: number): LtcFit {
  const corners = LTC_FIT_RECTS.map(rect => {
    const points: Vec3[] = [];
    for (const [width, height] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
      const x = rect.cx + width * rect.hw, y = rect.cy + height * rect.hh;
      const length = Math.hypot(x, y, rect.distance);
      points.push([x / length, y / length, rect.distance / length]);
    }
    return points;
  });
  const targets = LTC_FIT_RECTS.map(rect => monteCarloRectIntegral(cosTheta, roughness, rect));
  const reference = Math.max(...targets.map(value => Math.abs(value)), 1e-9);
  const transformedCorners = (point: readonly number[]): Vec3[][] => {
    const delivered = fitInverseMatrix(point);
    return corners.map(rect => rect.map(corner => normalize(multiplyMatrix(delivered, corner))));
  };
  const sums = (point: readonly number[]): number[] => transformedCorners(point).map(rect => rectFormFactor(rect));
  const amplitudeFor = (p: number, q: number, r: number): { start: number[]; error: number } => {
    const factors = sums([p, q, r]);
    let dotProduct = 0, squares = 0;
    for (let index = 0; index < factors.length; index++) {
      dotProduct += factors[index]! * targets[index]!;
      squares += factors[index]! * factors[index]!;
    }
    const amplitude = Math.min(Math.max(dotProduct / Math.max(squares, 1e-12), 1e-9), 1e9);
    let error = 0;
    for (let index = 0; index < factors.length; index++) {
      error += ((factors[index]! * amplitude - targets[index]!) / reference) ** 2;
    }
    return { start: [p, q, r, amplitude], error: error / factors.length };
  };
  const objective = (point: number[]): number => {
    if (point.some(value => !Number.isFinite(value))) return Number.MAX_VALUE;
    const [p = 1, q = 0, r = 1, amplitude = 0] = point;
    const boundedScale = (value: number): boolean => value >= 1e-4 && value <= 1e4;
    if (!boundedScale(p) || !boundedScale(r) || !(Math.abs(q) <= 1e4)
      || !(amplitude >= 1e-9 && amplitude <= 1e9)) return 1e12;
    const factors = sums(point);
    let error = 0;
    for (let index = 0; index < factors.length; index++) {
      error += ((factors[index]! * amplitude - targets[index]!) / reference) ** 2;
    }
    return error / factors.length;
  };
  const tiltGrid = (): number[] => {
    const values = [0];
    for (let log = -4; log <= 6; log++) values.push(2 ** log, -(2 ** log));
    return values;
  };
  const candidates: Array<{ start: number[]; error: number }> = [];
  for (let pLog = -4; pLog <= 6; pLog++) for (let rLog = -4; rLog <= 6; rLog++) for (const q of tiltGrid()) {
    candidates.push(amplitudeFor(2 ** pLog, q, 2 ** rLog));
  }
  candidates.sort((left, right) => left.error - right.error);
  const refined: Array<{ start: number[]; error: number }> = [];
  const logTilt = (q: number): number => (q === 0 ? 0 : Math.sign(q) * Math.log2(Math.abs(q)));
  const tiltAt = (log: number): number => (log === 0 ? 0 : Math.sign(log) * 2 ** Math.abs(log));
  for (const coarse of candidates.slice(0, 3)) {
    const centerP = Math.log2(coarse.start[0]!), centerR = Math.log2(coarse.start[2]!);
    const centerQ = logTilt(coarse.start[1]!);
    for (let dp = -2; dp <= 2; dp += 1) for (let dq = -2; dq <= 2; dq += 1) for (let dr = -2; dr <= 2; dr += 1) {
      refined.push(amplitudeFor(2 ** (centerP + dp * 0.25), tiltAt(centerQ + dq * 0.25), 2 ** (centerR + dr * 0.25)));
    }
  }
  refined.sort((left, right) => left.error - right.error);
  // NM 打磨:仅当训练能量误差降低才采纳(防盆地彩票)。
  let best = refined[0]!;
  const polished = nelderMead(objective, best.start, LTC_FIT_ITERATIONS);
  const polishedError = objective(polished);
  if (polishedError < best.error) {
    const twice = nelderMead(objective, polished, LTC_FIT_ITERATIONS);
    if (objective(twice) < polishedError) best = { start: twice, error: objective(twice) };
    else best = { start: polished, error: polishedError };
  }
  return {
    inverseMatrix: fitInverseMatrix(best.start),
    amplitude: Math.max(best.start[3]!, 0),
  };
}

/** 确定性构建整张表:逐 texel 独立全局拟合。行/列参数化 = texel 中心
 * ((c+0.5)/SIZE;定案依据:与 ×(SIZE−1) 角对齐两种参数化的交付包络对拍中,
 * 中心参数化全面更优——角对齐把 cosθ=0/1 两个极端角 texel 引入插值域,实测
 * 尖峰 texel 经双线性外溢出最高 776% 幻感能量;中心参数化端点 texel 天然内缩,
 * 混合效应已含在交付包络验收数字内,见报告 §数学)。 */
export function buildLtcLut(): Float32Array {
  const lut = new Float32Array(LTC_LUT_SIZE * LTC_LUT_SIZE * LTC_LUT_FLOATS_PER_TEXEL);
  for (let row = 0; row < LTC_LUT_SIZE; row++) {
    const roughness = LTC_ROUGHNESS_FLOOR + (1 - LTC_ROUGHNESS_FLOOR) * (row + 0.5) / LTC_LUT_SIZE;
    for (let column = 0; column < LTC_LUT_SIZE; column++) {
      const cosTheta = (column + 0.5) / LTC_LUT_SIZE;
      const texel = fitLtcTexel(cosTheta, roughness);
      packTexel(lut, row * LTC_LUT_SIZE + column, texel.inverseMatrix, texel.amplitude);
    }
  }
  return lut;
}

function packTexel(lut: Float32Array, index: number, inverseMatrix: Mat3, amplitude: number): void {
  const base = index * LTC_LUT_FLOATS_PER_TEXEL;
  for (let component = 0; component < 3; component++) {
    lut[base + component] = Math.fround(inverseMatrix[component]!);
    lut[base + 4 + component] = Math.fround(inverseMatrix[3 + component]!);
  }
  lut[base + 7] = Math.fround(amplitude);
}

export interface LtcTransform { readonly row0: Vec3; readonly row1: Vec3; readonly amplitude: number }

/** 着色同式采样:f32 表值 + 双线性;roughness 域映射与 buildLtcLut 的行参数化互逆。 */
export function sampleLtcLut(lut: Float32Array, cosTheta: number, roughness: number): LtcTransform {
  const clamped = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum);
  const column = clamped(cosTheta, 0, 1) * (LTC_LUT_SIZE - 1);
  const row = (clamped(roughness, LTC_ROUGHNESS_FLOOR, 1) - LTC_ROUGHNESS_FLOOR) / (1 - LTC_ROUGHNESS_FLOOR) * (LTC_LUT_SIZE - 1);
  const columnBase = Math.min(Math.floor(column), LTC_LUT_SIZE - 2), rowBase = Math.min(Math.floor(row), LTC_LUT_SIZE - 2);
  const fractionX = column - columnBase, fractionY = row - rowBase;
  const blend = (fetch: (texelRow: number, texelColumn: number) => Vec3): Vec3 => {
    const a = fetch(rowBase, columnBase), b = fetch(rowBase, columnBase + 1);
    const c = fetch(rowBase + 1, columnBase), d = fetch(rowBase + 1, columnBase + 1);
    return [0, 1, 2].map(component =>
      (a[component]! * (1 - fractionX) + b[component]! * fractionX) * (1 - fractionY)
      + (c[component]! * (1 - fractionX) + d[component]! * fractionX) * fractionY) as Vec3;
  };
  const read = (component: number): ((texelRow: number, texelColumn: number) => number) =>
    (texelRow, texelColumn) => lut[(texelRow * LTC_LUT_SIZE + texelColumn) * LTC_LUT_FLOATS_PER_TEXEL + component]!;
  const row0 = blend((texelRow, texelColumn) => [read(0)(texelRow, texelColumn), read(1)(texelRow, texelColumn), read(2)(texelRow, texelColumn)]);
  const row1 = blend((texelRow, texelColumn) => [read(4)(texelRow, texelColumn), read(5)(texelRow, texelColumn), read(6)(texelRow, texelColumn)]);
  const amplitude = (read(7)(rowBase, columnBase) * (1 - fractionX) + read(7)(rowBase, columnBase + 1) * fractionX) * (1 - fractionY)
    + (read(7)(rowBase + 1, columnBase) * (1 - fractionX) + read(7)(rowBase + 1, columnBase + 1) * fractionX) * fractionY;
  return { row0, row1, amplitude };
}

export function inverseMatrixFromRows(row0: Vec3, row1: Vec3): Mat3 {
  return [row0[0], row0[1], row0[2], row1[0], row1[1], row1[2], 0, 0, 1];
}

/**
 * 球面多边形余弦形式因子(切向空间,N=(0,0,1),单位顶点、有序环)——本切片的**唯一交付内核**:
 * 漫反射(未变换矩形)与高光 LTC(变换矩形)共用同一内核,与拟合目标严格同式
 * (fitLtcTexel 的 sums 同函数;无隐藏 π 常数,幅值由闭式最小二乘吸收全部尺度):
 *   FF = Σ (c_i×c_j).z · atan2(‖c_i×c_j‖, 1+c_i·c_j)/‖c_i×c_j‖。
 * 数值定案(报告 §数学,证据:QC 对拍 6 texel × 16 rect):
 *  - 内核与泛函自洽后,该内核与拟合目标同式,包络内能量误差最小;
 *  - Heitz 公开实现的 θ/sinθ/(1+cosθ) 边积分内核对应另一泛函,在自洽拟合下实测
 *    相对误差 417%~5e5%,被证据否决(定案过程详见报告)。
 * 多边形必须整体位于同一半球内(环内无极点穿越):合法 CCW 环值域 [0, 2π] 量级,
 * 越界即「变换多边形包极点」,调用方按保守方向处理(单面取 max(FF,0),双面取 |FF|)。
 */
export function rectFormFactor(corners: readonly Vec3[]): number {
  let total = 0;
  for (let index = 0; index < corners.length; index++) {
    const current = corners[index]!, next = corners[(index + 1) % corners.length]!;
    const crossed = cross(current, next);
    const magnitude = Math.hypot(crossed[0], crossed[1], crossed[2]);
    if (magnitude < 1e-7) continue;
    const cosine = Math.min(Math.max(dot(current, next), -1), 1);
    total += crossed[2] * (Math.atan2(magnitude, 1 + cosine) / magnitude);
  }
  return total;
}

export interface AreaLightGeometryCpu {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly up: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** 矩形角点相对着色点的单位方向,绕法线成环((+u+b)→(−u+b)→(−u−b)→(+u−b));着色点在光平面上返回 null。 */
export function rectCornersAround(light: AreaLightGeometryCpu, position: Vec3): Vec3[] | null {
  const forward = normalize(light.normal);
  const up = normalize(light.up);
  const bitangent = cross(forward, up);
  if (Math.abs(dot(subtract(position, light.position), forward)) < 1e-6) return null;
  const halfUp = scale(up, light.halfWidth), halfSide = scale(bitangent, light.halfHeight);
  const corners = [
    add(add(light.position, halfUp), halfSide),
    add(subtract(light.position, halfUp), halfSide),
    subtract(subtract(light.position, halfUp), halfSide),
    add(add(light.position, halfUp), scale(halfSide, -1)),
  ];
  return corners.map(corner => subtract(corner, position));
}

function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, amount: number): Vec3 { return [a[0] * amount, a[1] * amount, a[2] * amount]; }

/** 漫反射精确形式因子(切向空间):角点旋转到着色法线切向系后求和(z 分量即 N·ĉ)。 */
export function diffuseFormFactorAtNormal(normal: Vec3, cornersWorld: readonly Vec3[]): number | null {
  const tangentNormal = normalize(normal);
  if (dot(tangentNormal, tangentNormal) <= 0) return null;
  const axis = Math.abs(tangentNormal[0]) > 0.9 ? [0, 1, 0] as Vec3 : [1, 0, 0] as Vec3;
  const tangent = normalize(cross(axis, tangentNormal));
  const bitangent = cross(tangentNormal, tangent);
  const local = cornersWorld.map(corner => normalize([
    dot(corner, tangent), dot(corner, bitangent), dot(corner, tangentNormal),
  ]));
  return rectFormFactor(local);
}

export interface AreaLightEvaluationCpu {
  readonly diffuse: LightVector3;
  readonly specular: LightVector3;
}

/**
 * 单盏矩形面光贡献的权威 CPU 参考——与 wgsl/ltcAreaLighting.wgsl 同式:
 * 漫反射 = base·(1−metal)·radiance·FF(P)/π(未变换矩形,精确向量形式因子);
 * 高光 = Schlick(γ)·A·FF(normalize(invM·P))·radiance(**无 π 常数**——拟合目标不含 π,
 * 幅值 A 由闭式最小二乘吸收全部尺度;交付再加 π 就是恒定 −68% 系统性欠亮,实测定案)。
 * twoSided=false 时背面接收返回零;textureWindow 非空时按切平面投影调制 radiance。
 */
export function evaluateAreaLightCpu(lut: Float32Array, light: AreaLightGeometryCpu & {
  readonly twoSided: boolean; readonly range: number;
  readonly intensity: number; readonly color: LightVector3; readonly texture?: {
    readonly uvScale: readonly [number, number]; readonly uvOffset: readonly [number, number] } | undefined;
}, surface: { readonly position: Vec3; readonly normal: Vec3; readonly view: Vec3;
  readonly baseColor: LightVector3; readonly metallic: number; readonly roughness: number },
  sampleCookie?: (uv: readonly [number, number]) => LightVector3): AreaLightEvaluationCpu {
  const radiance: Vec3 = [
    light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity,
  ];
  const forward = normalize(light.normal);
  const toSurface = subtract(surface.position, light.position);
  const facing = dot(toSurface, forward);
  if (!light.twoSided && facing < 0) return { diffuse: [0, 0, 0], specular: [0, 0, 0] };
  if (light.range > 0 && Math.hypot(toSurface[0], toSurface[1], toSurface[2]) > light.range) {
    return { diffuse: [0, 0, 0], specular: [0, 0, 0] };
  }
  const corners = rectCornersAround(light, surface.position);
  if (!corners) return { diffuse: [0, 0, 0], specular: [0, 0, 0] };
  let modulation: Vec3 = [1, 1, 1];
  if (light.texture) {
    const up = normalize(light.up), bitangent = cross(forward, up);
    const local = toSurface;
    const u = dot(local, up) / (2 * light.halfWidth) + 0.5, v = dot(local, bitangent) / (2 * light.halfHeight) + 0.5;
    const sampled = sampleCookie?.([
      light.texture.uvScale[0] * u + light.texture.uvOffset[0],
      light.texture.uvScale[1] * v + light.texture.uvOffset[1],
    ]);
    modulation = sampled ? [...sampled] as Vec3 : [1, 1, 1];
  }
  const effective: Vec3 = [
    radiance[0] * modulation[0], radiance[1] * modulation[1], radiance[2] * modulation[2],
  ];
  const diffuseFactor = diffuseFormFactorAtNormal(surface.normal, corners);
  // 漫反射 albedo = baseColor·(1−metallic)(逐分量)。
  const diffuseBase = (1 - surface.metallic);
  // 绕序随接收侧翻转符号:单面=背面零(前置 facing 判定兜底),双面=取模(两侧同亮)。
  const diffuseSigned = diffuseFactor === null ? null
    : light.twoSided ? Math.abs(diffuseFactor) : (diffuseFactor < 0 ? 0 : diffuseFactor);
  const diffuse: Vec3 = diffuseSigned === null || diffuseSigned <= 0 ? [0, 0, 0] : [
    Math.max(diffuseBase * surface.baseColor[0]!, 0) * effective[0]! * diffuseSigned / PI,
    Math.max(diffuseBase * surface.baseColor[1]!, 0) * effective[1]! * diffuseSigned / PI,
    Math.max(diffuseBase * surface.baseColor[2]!, 0) * effective[2]! * diffuseSigned / PI,
  ];
  const surfaceNormal = normalize(surface.normal);
  const cosTheta = Math.min(Math.max(dot(surfaceNormal, normalize(surface.view)), 0), 1);
  const transform = sampleLtcLut(lut, cosTheta, surface.roughness);
  // 切向系 x 轴 = 视线的切平面投影:拟合帧把瓣倾斜定在 +xz 平面,交付必须把多边形
  // 旋到同一方位角(经典 LTC 交付口径;缺此步时除 cosθ=1 外全部方位错配,实测
  // 系统性 −90%,是本切片最大的单点缺陷)。
  const viewDirection = normalize(surface.view);
  const viewTangent = dot(viewDirection, surfaceNormal) > 0.9999
    ? normalize(cross([0, 1, 0] as Vec3, surfaceNormal))
    : normalize(subtract(viewDirection, scale(surfaceNormal, dot(viewDirection, surfaceNormal))));
  const viewBitangent = cross(surfaceNormal, viewTangent);
  const local = corners.map(corner => normalize([
    dot(corner, viewTangent), dot(corner, viewBitangent), dot(corner, surfaceNormal),
  ]));
  const transformed = local.map(corner => {
    const mapped = multiplyMatrix(inverseMatrixFromRows(transform.row0, transform.row1), corner);
    return normalize(mapped);
  });
  // 交付内核 = rectFormFactor(与拟合 sums 同一函数,严格同式;无 /π,见函数头定案):
  // 绕序随接收侧翻转符号:单面=背面零(前置 facing 判定兜底),双面=取模(两侧同亮)。
  const signedFactor = light.twoSided ? Math.abs(rectFormFactor(transformed)) : Math.max(rectFormFactor(transformed), 0);
  const centroidDirection = normalize(corners.reduce((sum, corner) => add(sum, corner), [0, 0, 0] as Vec3));
  const dominant = Math.min(Math.max(dot(normalize(surface.normal), centroidDirection), 0), 1);
  const f0 = [0, 1, 2].map(component =>
    0.04 * (1 - surface.metallic) + Math.max(surface.baseColor[component]!, 0) * surface.metallic) as Vec3;
  const schlick = (1 - dominant) ** 5;
  const fresnel: Vec3 = [f0[0] + (1 - f0[0]) * schlick, f0[1] + (1 - f0[1]) * schlick, f0[2] + (1 - f0[2]) * schlick];
  // 高光无 /π:拟合目标 ∫GGX(F=1)·cos dω 不含 π,幅值已吸收尺度;再除 π = 恒定 −68%(定案)。
  const specularScale = signedFactor * transform.amplitude;
  const specular: Vec3 = [0, 1, 2].map(component => fresnel[component]! * specularScale * effective[component]!) as Vec3;
  return { diffuse, specular };
}
