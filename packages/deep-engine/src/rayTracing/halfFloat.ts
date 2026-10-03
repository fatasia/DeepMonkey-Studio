/**
 * IEEE 754 binary16（half float）转换（compute BVH 光追骨架的 f16 节点压缩基座）。
 * WGSL f16 storage 节点（BvhNodeF16，32B stride）要求把 f32 bounds 量化到 f16 网格；
 * 遍历盒只用于剪枝，**外扩量化**（min 向 -Inf、max 向 +Inf 取到包容原值的 f16 值）保证
 * 存储盒 ⊇ 原盒 ⇒ GPU 剪枝只会变松、命中结果与 f32 布局逐位一致（probe 对拍钉死）。
 * 浮点为符号-数值表示，外扩方向按**带符号值**定义：outwardLow=stored ≤ v、
 * outwardHigh=stored ≥ v（负数时数值方向与尾数方向相反，内部归一为尾数 truncate/up）。
 * 转换为纯整数位运算（无查表），同输入逐位同输出；超出 f16 有限范围取 ±Infinity
 * （遍历对 ±Inf 盒安全：slab 测试对平行轴只测 origin-in-slab，不产生 0×Inf）。
 */

const F16_SIGN_MASK = 0x8000;
const F16_EXP_MASK = 0x7c00;
const F16_FRAC_MASK = 0x03ff;
const F32_EXP_MASK = 0x7f80_0000;
const F32_FRAC_MASK = 0x007f_ffff;
const F32_SIGN_SHIFT = 16;
/** f16 编码指数合法上界 30（31 为 Inf/NaN 区）；|v| ≥ 2^16 走溢出分支。 */
const F16_ENCODED_EXP_MAX = 30;

export type F16Rounding = "nearest" | "outwardLow" | "outwardHigh";
/** 归一到尾数方向（数值方向按符号翻转后）：truncate=向 0、up=远离 0。 */
type MagnitudeRounding = "nearest" | "truncate" | "up";

/** f32 → f16 raw 位型；rounding 见头注释（nearest=最近偶数）。 */
export function floatToF16Bits(value: number, rounding: F16Rounding = "nearest"): number {
  const word = new Uint32Array(1);
  new Float32Array(word.buffer)[0] = value;
  const bits = word[0]!;
  const sign = (bits >>> 31) & 1;
  const exponent32 = (bits & F32_EXP_MASK) >>> 23;
  const fraction32 = bits & F32_FRAC_MASK;
  const signBit = sign * F16_SIGN_MASK;
  if (exponent32 === 0xff) return signBit | (fraction32 !== 0 ? 0x7e00 : F16_EXP_MASK); // NaN/Inf。
  const magnitude = magnitudeRounding(sign === 1, rounding);
  const encoded = exponent32 - 112; // f16 编码指数 = E32 - 127 + 15。
  if (encoded >= F16_ENCODED_EXP_MAX + 1) return overflow(signBit, magnitude);
  if (encoded >= 1) return packNormal(signBit, encoded, fraction32, magnitude);
  return packSubnormal(signBit, exponent32, fraction32, magnitude);
}

/** f16 raw 位型 → f32（精确；f16 ⊂ f32 无舍入）。 */
export function f16BitsToFloat(bits: number): number {
  const sign = bits & F16_SIGN_MASK;
  const exponent = (bits & F16_EXP_MASK) >>> 10;
  const fraction = bits & F16_FRAC_MASK;
  const word = new Uint32Array(1);
  if (exponent === 0x1f) word[0] = (sign << F32_SIGN_SHIFT) | 0x7f80_0000 | (fraction << 13);
  else if (exponent === 0) {
    if (fraction === 0) word[0] = sign << F32_SIGN_SHIFT;
    else {
      // 归一 denormal：fraction 最高位 p → 无偏指数 p-24（value = fraction×2^-24）；
      // 循环 s 次移位到 bit10 ⇒ p = e+11，biased = 127 + p - 24 = 114 + e。
      let e = -1, f = fraction;
      while ((f & 0x0400) === 0) { f <<= 1; e--; }
      word[0] = (sign << F32_SIGN_SHIFT) | ((114 + e) << 23) | ((f & F16_FRAC_MASK) << 13);
    }
  } else word[0] = (sign << F32_SIGN_SHIFT) | ((exponent - 15 + 127) << 23) | (fraction << 13);
  return new Float32Array(word.buffer)[0]!;
}

function magnitudeRounding(negative: boolean, rounding: F16Rounding): MagnitudeRounding {
  if (rounding === "nearest") return "nearest";
  // 正数：outwardHigh=up、outwardLow=truncate；负数：数值方向反转。
  return negative === (rounding === "outwardLow") ? "up" : "truncate";
}

function packNormal(signBit: number, encoded: number, fraction32: number, mode: MagnitudeRounding): number {
  const dropped = fraction32 >>> 13;
  let bits = signBit | (encoded << 10) | dropped;
  const residue = fraction32 & 0x1fff;
  if (mode === "nearest") {
    const roundBit = (fraction32 >>> 12) & 1;
    const sticky = fraction32 & 0x0fff;
    if (roundBit === 1 && (sticky !== 0 || (dropped & 1) === 1)) bits = increment(bits, signBit);
  } else if (mode === "up" && residue !== 0) bits = increment(bits, signBit);
  return bits;
}

function packSubnormal(signBit: number, exponent32: number, fraction32: number, mode: MagnitudeRounding): number {
  // 目标网格数 grid = v × 2^24（f32 denormal → 恒小于半格；正规拼隐含位后右移 126-E32 位）。
  // f32 尾数 ≤ 23 位有效 + 指数 ≤ 14 位移位，grid 是 f64 可精确表示的整数值/整数+小数，
  // floor 与余数比较均精确 ⇒ 同输入逐位同输出。
  const value = exponent32 === 0 ? fraction32 * 2 ** -126 : (1 + fraction32 / 2 ** 23) * 2 ** (exponent32 - 127);
  const grid = value * 2 ** 24;
  if (!(grid > 0)) return signBit | (mode === "up" && value > 0 ? 1 : 0); // 0 或半格以下上抬一格。
  const floor = Math.floor(grid);
  let magnitude = floor;
  if (mode === "up" && grid > floor) magnitude = floor + 1;
  else if (mode === "nearest" && grid > floor) {
    const half = grid - floor;
    if (half > 0.5 || (half === 0.5 && magnitude % 2 === 1)) magnitude = floor + 1;
  }
  if (magnitude > F16_FRAC_MASK) return signBit | (1 << 10); // 进位抬到最小正规数 2^-14（仍包容 v）。
  return signBit | magnitude;
}

function overflow(signBit: number, mode: MagnitudeRounding): number {
  // |v| ≥ 2^16：truncate（外扩取有限最大值 65504）；nearest/up 取 ±Infinity（唯一包容值）。
  if (mode === "truncate") return signBit | (F16_ENCODED_EXP_MAX << 10) | F16_FRAC_MASK;
  return signBit | F16_EXP_MASK;
}

function increment(bits: number, signBit: number): number {
  const magnitude = (bits & (F16_EXP_MASK | F16_FRAC_MASK)) + 1;
  if (magnitude >= F16_EXP_MASK) return signBit | F16_EXP_MASK; // e=30 全 1 进位抬到 Infinity。
  return signBit | magnitude;
}
