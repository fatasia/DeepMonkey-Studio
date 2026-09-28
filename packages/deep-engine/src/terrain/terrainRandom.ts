/**
 * T13 地形底座:确定性伪随机与值噪声。
 *
 * 确定性合同(T13 验收"相同输入/seed/算法版本下相同"):
 * - 全部使用 32 位整型运算(Math.imul / 移位),不存在 Math.random 与运行期全局状态;
 * - 唯一浮点运算是 uint32 → [0,1) 的除法与插值混合,IEEE double 基本运算,同引擎逐位确定;
 * - 噪声以 (x, z, seed) 为纯函数,采样顺序不影响结果,与分块划分无关(接缝连续的基础)。
 * - 跨 JS 引擎的逐位一致不在本合同内(文档见 docs/reports/deep-core/T13-implementation.md)。
 */

/** 2 的 32 次方的倒数,把 uint32 哈希映射到 [0,1)。 */
const INV_UINT32 = 1 / 4294967296;

/**
 * mulberry32 伪随机数生成器:返回 () => number,输出 [0,1)。
 * 同一 seed 得到逐位相同序列;不同 seed 序列 statistically 独立。
 */
export function createMulberry32(seed: number): () => number {
  let state = seed | 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) * INV_UINT32;
  };
}

/**
 * 整数格点哈希:把 (x, z, seed) 混合为 uint32。
 * splitmix 风格雪崩;仅整型运算,同输入逐位同输出。
 */
export function hashGrid2D(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** 嵌套派生 seed:外层哈希作为内层 seed,供"每块/每层独立随机流"使用。 */
export function deriveSeed(seed: number, salt: number): number {
  return hashGrid2D(salt, 0x5f356495, seed);
}

/** C2 连续平滑函数 6t^5 - 15t^4 + 10t^3(quintic),保证噪声一阶/二阶导连续。 */
function smoothQuintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export type Noise2D = (x: number, z: number) => number;

/**
 * 二维值噪声:格点值由 hashGrid2D 决定,双线性插值 + quintic 平滑。
 * 输出 [0,1);对 (x, z) 为纯函数,整数格点处的值恰为该格点哈希(两侧极限一致)。
 */
export function createValueNoise2D(seed: number): Noise2D {
  return (x: number, z: number): number => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const tx = x - xi;
    const tz = z - zi;
    const sx = smoothQuintic(tx);
    const sz = smoothQuintic(tz);
    const v00 = hashGrid2D(xi, zi, seed) * INV_UINT32;
    const v10 = hashGrid2D(xi + 1, zi, seed) * INV_UINT32;
    const v01 = hashGrid2D(xi, zi + 1, seed) * INV_UINT32;
    const v11 = hashGrid2D(xi + 1, zi + 1, seed) * INV_UINT32;
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sz;
  };
}

/**
 * 分形布朗运动(fBm):多层值噪声叠加,输出归一化到 [0,1]。
 * 各层用派生 seed,层内频率按 lacunarity 递增、振幅按 gain 递减。
 */
export function createFbm2D(seed: number, octaves: number, lacunarity = 2, gain = 0.5): Noise2D {
  if (!Number.isInteger(octaves) || octaves < 1 || octaves > 16) {
    throw new Error("Fbm octaves must be an integer in [1, 16].");
  }
  if (!(lacunarity > 1) || !(gain > 0 && gain < 1)) {
    throw new Error("Fbm lacunarity must be > 1 and gain in (0, 1).");
  }
  const layers: Noise2D[] = [];
  for (let i = 0; i < octaves; i += 1) {
    layers.push(createValueNoise2D(deriveSeed(seed, i + 1)));
  }
  return (x: number, z: number): number => {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < layers.length; i += 1) {
      sum += layers[i]!(x * frequency, z * frequency) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  };
}

/** 归一化平滑阶跃:edge0 处为 0,edge1 处为 1,C1 连续;用于平整区过渡带。 */
export function smoothstep01(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
