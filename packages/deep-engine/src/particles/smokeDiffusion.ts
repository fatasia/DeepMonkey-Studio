/**
 * T20 切片:烟体类模拟的 NaN 卫生与分辨率收敛趋势(CPU 一维扩散参考)。
 *
 * 口径声明:这是一维扩散的 CPU 参考解,用于固化"烟体无 NaN + 分辨率细化有收敛
 * 趋势 + 封闭边界质量守恒"三个可单测的卫生基线;不是三维流体/烟雾求解器,
 * 封闭流体 GPU 求解与体积渲染留联测切片。质量误差阈值对齐主计划 T20 的 ≤1%。
 *
 * 稳定性:显式格式要求 D·dt/dx² ≤ 0.5,超出抛 RangeError(明确失败),
 * 绝不允许静默发散出 NaN。
 */

export type SmokeBoundary = "closed" | "dirichlet";

export interface SmokeDiffusionOptions {
  readonly resolution: number;
  readonly steps: number;
  /** 扩散系数 D(单位域);dt 由稳定性界自动推导 = 0.4 / (D/dx²)。 */
  readonly diffusion: number;
  readonly boundary?: SmokeBoundary;
}

export interface SmokeDiffusionResult {
  readonly resolution: number;
  readonly steps: number;
  readonly boundary: SmokeBoundary;
  readonly deltaTime: number;
  readonly initialMass: number;
  readonly mass: number;
  /** 封闭边界质量漂移(无量纲);dirichlet 边界为吸收,不承诺守恒。 */
  readonly massDrift: number;
  readonly nonFiniteCount: number;
  readonly l2Error: number;
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}

function finite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be finite in ${minimum}..${maximum}.`);
  }
  return value;
}

/** 初始场:中心高斯 σ₀=0.05(单位周期域),质量归一由 mass 记录。 */
function initialField(resolution: number): Float64Array {
  const field = new Float64Array(resolution);
  const dx = 1 / resolution;
  const sigma = 0.05;
  let total = 0;
  for (let index = 0; index < resolution; index++) {
    const x = (index + 0.5) * dx - 0.5;
    const value = Math.exp(-x * x / (2 * sigma * sigma));
    field[index] = value;
    total += value;
  }
  for (let index = 0; index < resolution; index++) field[index] = field[index]! / total;
  return field;
}

/** 高斯扩散解析解(同归一化口径),用于 L2 误差与收敛趋势。 */
export function smokeAnalyticField(resolution: number, diffusion: number, totalTime: number): Float64Array {
  integer(resolution, "resolution", 2, 4096);
  finite(diffusion, "diffusion", 0, 100);
  finite(totalTime, "totalTime", 0, 3600);
  const field = new Float64Array(resolution);
  const dx = 1 / resolution;
  const sigma0 = 0.05;
  const sigma2 = sigma0 * sigma0 + 2 * diffusion * totalTime;
  let total = 0;
  for (let index = 0; index < resolution; index++) {
    const x = (index + 0.5) * dx - 0.5;
    const value = Math.exp(-x * x / (2 * sigma2));
    field[index] = value;
    total += value;
  }
  for (let index = 0; index < resolution; index++) field[index] = field[index]! / total;
  return field;
}

function massOf(field: Float64Array, dx: number): number {
  let total = 0;
  for (let index = 0; index < field.length; index++) total += field[index]!;
  return total * dx;
}

function l2ErrorOf(numeric: Float64Array, analytic: Float64Array, dx: number): number {
  let total = 0;
  for (let index = 0; index < numeric.length; index++) {
    const delta = numeric[index]! - analytic[index]!;
    total += delta * delta;
  }
  return Math.sqrt(total * dx);
}

/** 一维显式扩散;封闭(cyclic)边界守恒,dirichlet 边界两端吸收。 */
export function simulateSmokeDiffusion(options: SmokeDiffusionOptions): SmokeDiffusionResult {
  const resolution = integer(options.resolution, "resolution", 8, 4096);
  const steps = integer(options.steps, "steps", 1, 10_000_000);
  const diffusion = finite(options.diffusion, "diffusion", 0, 100);
  const boundary = options.boundary ?? "closed";
  const dx = 1 / resolution;
  const deltaTime = diffusion > 0 ? 0.4 * dx * dx / diffusion : 1;
  const field = initialField(resolution);
  const initialMass = massOf(field, dx);
  const scratch = new Float64Array(resolution);
  for (let step = 0; step < steps; step++) {
    for (let index = 0; index < resolution; index++) {
      const left = boundary === "closed" ? (index + resolution - 1) % resolution : index - 1;
      const right = boundary === "closed" ? (index + 1) % resolution : index + 1;
      const valueLeft = left >= 0 && left < resolution ? field[left]! : 0;
      const valueRight = right >= 0 && right < resolution ? field[right]! : 0;
      const laplacian = (valueLeft - 2 * field[index]! + valueRight) / (dx * dx);
      scratch[index] = field[index]! + diffusion * deltaTime * laplacian;
    }
    field.set(scratch);
  }
  let nonFiniteCount = 0;
  for (let index = 0; index < field.length; index++) {
    if (!Number.isFinite(field[index])) nonFiniteCount++;
  }
  // NaN 卫生:合法输入下该分支不可达;一旦触达即防御性失败,零 NaN 传播。
  if (nonFiniteCount > 0) throw new Error("Smoke diffusion produced non-finite values.");
  const mass = massOf(field, dx);
  const totalTime = deltaTime * steps;
  const analytic = smokeAnalyticField(resolution, diffusion, totalTime);
  return Object.freeze({ resolution, steps, boundary, deltaTime,
    initialMass, mass, massDrift: Math.abs(mass - initialMass) / initialMass,
    nonFiniteCount, l2Error: l2ErrorOf(field, analytic, dx) });
}

export interface SmokeConvergenceRow {
  readonly resolution: number;
  readonly l2Error: number;
}

/** 分辨率阶梯(固定扩散系数与总时长,steps 随稳定性界缩放):L2 误差应随细化下降。 */
export function smokeDiffusionConvergence(resolutions: readonly number[], diffusion: number,
  totalTime: number): readonly SmokeConvergenceRow[] {
  if (!Array.isArray(resolutions) || resolutions.length < 2) {
    throw new RangeError("resolutions must contain at least 2 entries.");
  }
  finite(diffusion, "diffusion", 0, 100);
  finite(totalTime, "totalTime", 0, 3600);
  return Object.freeze(resolutions.map(resolution => {
    const dx = 1 / integer(resolution, "resolution", 8, 4096);
    const dt = diffusion > 0 ? 0.4 * dx * dx / diffusion : 1;
    const steps = Math.max(1, Math.ceil(totalTime / dt));
    const result = simulateSmokeDiffusion({ resolution, steps, diffusion, boundary: "closed" });
    return Object.freeze({ resolution, l2Error: result.l2Error });
  }));
}
