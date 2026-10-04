import type { MaterialGraphMask } from "./materialGraphModel";

/**
 * 材质图程序化遮罩采样(编辑器刀 7)。
 *
 * 确定性硬约束:同一定义 → 同一字节输出。全部噪声由整数雪崩哈希驱动,
 * 无 Math.random、无时间、无平台相关浮点库;U/V 晶格周期取整数 → 贴图平铺无缝。
 * 任意角度经整数步长量化逼近(无缝优先于角度连续)。
 * 纯函数、零 DOM —— Node 单测直接断言字节级确定性。
 */

/** 整数坐标 → [0,1) 雪崩哈希(无符号 32 位混合);同入参恒同出参。 */
export function hashLattice(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 双周期周期化 value noise:U/V 各按整数周期取模,uv ∈ [0,1) 首尾无缝。 */
export function valueNoise2(u: number, v: number, periodU: number, periodV: number, seed: number): number {
  const x = u * periodU;
  const y = v * periodV;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smootherstep(x - x0);
  const fy = smootherstep(y - y0);
  const wrapU = (n: number) => ((n % periodU) + periodU) % periodU;
  const wrapV = (n: number) => ((n % periodV) + periodV) % periodV;
  const n00 = hashLattice(wrapU(x0), wrapV(y0), seed);
  const n10 = hashLattice(wrapU(x0 + 1), wrapV(y0), seed);
  const n01 = hashLattice(wrapU(x0), wrapV(y0 + 1), seed);
  const n11 = hashLattice(wrapU(x0 + 1), wrapV(y0 + 1), seed);
  return (n00 * (1 - fx) + n10 * fx) * (1 - fy) + (n01 * (1 - fx) + n11 * fx) * fy;
}

/** 2 octave 分形:第二层 U/V 频率 ×2(整数,仍无缝)、幅度 1/3,种子派生固定。 */
function fbm2(u: number, v: number, periodU: number, periodV: number, seed: number): number {
  return valueNoise2(u, v, periodU, periodV, seed) * (2 / 3)
    + valueNoise2(u, v, periodU * 2, periodV * 2, seed ^ 0x5f356495) * (1 / 3);
}

/** threshold + softness → 0/1 平滑阶跃;阶跃中心 = 1-coverage(coverage 大 → 面积大)。 */
function thresholdField(field: number, coverage: number, softness: number): number {
  const edge = 1 - Math.min(0.98, Math.max(0.02, coverage));
  const half = Math.max(0.004, softness * 0.35);
  return Math.min(1, Math.max(0, (field - (edge - half)) / (2 * half)));
}

const atLeastOne = (n: number) => Math.max(1, Math.round(n));

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 角度(度)→ 条纹法向整数计数 (nU, nV):θ=0 条纹沿 U(水平),计数在 V;
 * θ=90 条纹沿 V(垂直),计数在 U;θ=45 对角。至少一维非零(无缝前提)。
 */
export function angleSteps(angleDeg: number, period: number): { nU: number; nV: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const nU = Math.round(Math.abs(Math.sin(rad)) * period);
  const nV = Math.round(Math.abs(Math.cos(rad)) * period);
  if (nU === 0 && nV === 0) return { nU: 1, nV: 0 };
  return { nU, nV };
}

/**
 * 单点遮罩采样 → [0,1](texture 类型返回 -1:由编译器读上传图,网格另路)。
 * wear:主轴拉长的各向异性 fbm(划痕感,轴对齐近似);dust:低频柔和斑块;
 * stripes:沿角度的整数周期带,coverage 即占空比。
 */
export function sampleMaskAlpha(mask: MaterialGraphMask, u: number, v: number): number {
  if (mask.kind === "texture") return -1;
  const period = Math.max(1, mask.scale);
  if (mask.kind === "stripes") {
    const { nU, nV } = angleSteps(mask.angle, period);
    const coord = u * nU + v * nV;
    const band = coord - Math.floor(coord);
    const duty = Math.min(0.9, Math.max(0.1, mask.coverage));
    const soft = Math.min(0.25, Math.max(0.004, mask.softness * 0.25));
    return smoothstep(0, soft, band) * (1 - smoothstep(duty, duty + soft, band));
  }
  // wear:划痕沿角度主轴拉长 —— 主轴低频、跨轴 3 倍高频(轴对齐近似,保证无缝)。
  const alongU = Math.abs(Math.cos((mask.angle * Math.PI) / 180)) >= Math.abs(Math.sin((mask.angle * Math.PI) / 180));
  const { nU, nV } = alongU
    ? { nU: atLeastOne(period / 3), nV: atLeastOne(period * 3) }
    : { nU: atLeastOne(period * 3), nV: atLeastOne(period / 3) };
  const field = fbm2(u, v, nU, nV, mask.seed);
  return thresholdField(field, mask.coverage, mask.softness);
}

/**
 * 遮罩网格:size² 字节(0–255)。texture 类型需调用方提供 uploaded 采样回调
 * (编译器从 ImageData 取亮度)。确定性:同参数两次调用逐字节相等。
 */
export function maskGrid(
  mask: MaterialGraphMask,
  size: number,
  sampleTexture?: (u: number, v: number) => number,
): Uint8ClampedArray {
  const grid = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const alpha = mask.kind === "texture"
        ? (sampleTexture ? Math.min(1, Math.max(0, sampleTexture(u, v))) : 0)
        : sampleMaskAlpha(mask, u, v);
      grid[y * size + x] = Math.round(alpha * 255);
    }
  }
  return grid;
}
