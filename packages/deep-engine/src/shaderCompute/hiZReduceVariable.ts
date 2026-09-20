import type { DcirKernel, DcirNode } from "./types.js";
import { KernelBuilder } from "./kernel.js";

/**
 * HiZ 生产变窗缩减内核：与 `webgpu/hiZPyramid.ts` 原手写 `HI_Z_REDUCE_WGSL` 逐位同语义的
 * DCIR v0 表达（R4 生产接线切片）。原公式：
 *   begin = id*src/dst（截断除）；end = ((id+1)*src + dst - 1)/dst（进位除）
 *   种子 = load(begin)，随后按 y 外层、x 内层定序 min/max gather。
 * v0 无循环/变窗 op，但 GPU mip 链口径 dst = max(1, floor(src/2)) 下窗口 end-begin ≤ 3
 * （奇数源恒为 3，偶数源恒为 2），因此 3×3=9 次 masked 定序 tap 精确覆盖：越窗 tap 以
 * select 回退当前累加值（min/max 幂等，无数值影响），取数坐标 clamp 入界满足
 * texel-load 合同（GLSL texelFetch 越界未定义）。tap 展开 = 生产循环展开，求值顺序同构。
 * 约束：targetSize 必须取 GPU mip 链口径（floor 链）；任意其他映射的窗口可能 >3，属未定义。
 * 输出按 R2 合同 canonicalize（-0 折叠为 +0）；原手写路径无此折叠，±0 格差异在对拍中
 * 以"折叠后逐位相等"档判定（确定性合同 §4.3，修复的是原路径固有的跨后端 -0 择向风险）。
 * 与已认证的 2×2 锚定块内核（`hi_z_first_stage`）分工：偶×偶源窗口恰为 2×2，两语义重合，
 * 走 4-tap 快路径；其余源（含奇数维）走本内核。
 */

export const HI_Z_VARIABLE_REDUCE_NAME = "hi_z_variable_reduce";

/** GPU mip 链口径：level L 尺寸 = max(1, floor(size / 2^L))（与 webgpu/hiZPyramid.ts 一致）。 */
export function hiZChainLevelSize(size: number, level: number): number {
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(level) || size < 1 || level < 0) {
    throw new Error("Hi-Z chain level size requires nonnegative safe integers.");
  }
  return Math.max(1, Math.floor(size / 2 ** level));
}

export function buildHiZVariableReduceKernel(reduceMax: boolean): DcirKernel {
  const b = new KernelBuilder();
  const push = (node: DcirNode): string => b.push(node);
  const litU32 = (id: string, value: number): string => push({ id, type: "u32", op: "literal", value });
  const litBool = (id: string, value: boolean): string => push({ id, type: "bool", op: "literal", value });
  const binInt = (id: string, op: "iadd" | "isub" | "imul" | "idiv", a: string, c: string): string =>
    push({ id, type: "u32", op, inputs: [a, c] });
  const cmp = (id: string, op: "ieq" | "ult", a: string, c: string): string => push({ id, type: "bool", op, inputs: [a, c] });
  const sel = (id: string, falseValue: string, trueValue: string, condition: string): string =>
    push({ id, type: "u32", op: "select", inputs: [falseValue, trueValue, condition] });
  const selF = (id: string, falseValue: string, trueValue: string, condition: string): string =>
    push({ id, type: "f32", op: "select", inputs: [falseValue, trueValue, condition] });
  const andBool = (id: string, a: string, c: string): string =>
    push({ id, type: "bool", op: "select", inputs: [litBool(`${id}_f`, false), a, c] });

  const gid = push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const tx = push({ id: "tx", type: "u32", op: "component", input: gid, component: 0 });
  const ty = push({ id: "ty", type: "u32", op: "component", input: gid, component: 1 });
  const src = push({ id: "sourceSize", type: "vec2u", op: "kernel-uniform", uniform: "sourceSize" });
  const dst = push({ id: "targetSize", type: "vec2u", op: "kernel-uniform", uniform: "targetSize" });
  const sw = push({ id: "sw", type: "u32", op: "component", input: src, component: 0 });
  const sh = push({ id: "sh", type: "u32", op: "component", input: src, component: 1 });
  const tw = push({ id: "tw", type: "u32", op: "component", input: dst, component: 0 });
  const th = push({ id: "th", type: "u32", op: "component", input: dst, component: 1 });
  const inside = andBool("inside", cmp("inx", "ult", tx, tw), cmp("iny", "ult", ty, th));
  const one = litU32("one", 1);
  const off1 = litU32("off1", 1);
  const off2 = litU32("off2", 2);

  // 窗口 [begin, end)：begin = t*src/dst（截断除），end = ((t+1)*src + dst-1)/dst（进位除）。
  // 全部整数精确（u32 域内 prod ≤ 2^27，见生产尺寸上限 16384）。
  const window = (axis: "x" | "y", t: string, s: string, d: string): { begin: string; end: string; limit: string } => {
    const product = binInt(`${axis}p`, "imul", t, s);
    return {
      begin: binInt(`${axis}b`, "idiv", product, d),
      end: binInt(`${axis}e`, "idiv",
        binInt(`${axis}q`, "iadd", binInt(`${axis}n`, "iadd", product, s), binInt(`${axis}m`, "isub", d, one)), d),
      limit: binInt(`${axis}m1`, "isub", s, one),
    };
  };
  const wx = window("x", tx, sw, tw);
  const wy = window("y", ty, sh, th);

  // 每 tap：越窗坐标 clamp 入界（结果被 select 丢弃，只为满足 texel-load 界内合同）。
  const taps = (axis: "x" | "y", begin: string, end: string, limit: string): readonly { valid: string; coord: string }[] =>
    [0, 1, 2].map((offset): { valid: string; coord: string } => {
      const suffix = `${axis}${offset}`;
      if (offset === 0) {
        return { valid: cmp(`v${suffix}`, "ult", begin, end), coord: sel(`c${suffix}`, limit, begin, `v${suffix}`) };
      }
      const raw = binInt(`b${suffix}`, "iadd", begin, offset === 1 ? off1 : off2);
      const valid = cmp(`v${suffix}`, "ult", raw, end);
      return { valid, coord: sel(`c${suffix}`, limit, raw, `v${suffix}`) };
    });
  const xs = taps("x", wx.begin, wx.end, wx.limit);
  const ys = taps("y", wy.begin, wy.end, wy.limit);

  // loads[ix][iy] = 取数坐标 (cx_ix, cy_iy)。定序归约：种子 (bx,by) 后按 y 外层、x 内层 9 tap
  // 展开 = 生产循环展开顺序；首 tap 重复归约种子与生产循环首迭代同构（min/max 幂等）。
  const loads = xs.map((x) => ys.map((y) => {
    const coords = push({ id: `co_${x.coord}_${y.coord}`, type: "vec2u", op: "make-vec2u", inputs: [x.coord, y.coord] });
    return push({ id: `s_${x.coord}_${y.coord}`, type: "f32", op: "texel-load", coords });
  }));
  let acc = loads[0]![0]!;
  for (let iy = 0; iy < 3; iy++) {
    for (let ix = 0; ix < 3; ix++) {
      const valid = andBool(`w${ix}${iy}`, xs[ix]!.valid, ys[iy]!.valid);
      const candidate = selF(`a${ix}${iy}`, acc, loads[ix]![iy]!, valid);
      acc = push({ id: `r${ix}${iy}`, type: "f32", op: reduceMax ? "fmax" : "fmin", inputs: [acc, candidate] });
    }
  }
  const value = push({ id: "value", type: "f32", op: "canonicalize-f32", input: acc });
  return {
    name: HI_Z_VARIABLE_REDUCE_NAME,
    textureIo: "r32float",
    workgroupSize: [8, 8],
    uniforms: [
      { name: "sourceSize", type: "vec2u" },
      { name: "targetSize", type: "vec2u" },
    ],
    nodes: b.nodes(),
    guard: inside,
    output: { coords: gid, value },
  };
}

/** 精确整数除法（避免浮点商舍入；值域 < 2^53 保证精确）。 */
const divTrunc = (numerator: number, divisor: number): number => (numerator - (numerator % divisor)) / divisor;

/**
 * CPU 参考实现：与原手写 WGSL 相同的变窗定序 gather + 输出 canonicalize。
 * 生产循环坐标恒在界内（end ≤ src 可证），参考实现直接取数不做 clamp。
 */
export function referenceHiZVariableReduce(input: Float32Array, sourceWidth: number, sourceHeight: number,
  targetWidth: number, targetHeight: number, reduceMax: boolean): Float32Array {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
    || !Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight)
    || sourceWidth < 1 || sourceHeight < 1 || targetWidth < 1 || targetHeight < 1) {
    throw new Error("Hi-Z variable reduce reference requires positive safe integer dimensions.");
  }
  if (input.length < sourceWidth * sourceHeight) throw new Error("Hi-Z reference input is smaller than declared source.");
  const output = new Float32Array(targetWidth * targetHeight);
  for (let ty = 0; ty < targetHeight; ty++) {
    for (let tx = 0; tx < targetWidth; tx++) {
      const beginX = divTrunc(tx * sourceWidth, targetWidth);
      const endX = divTrunc((tx + 1) * sourceWidth + targetWidth - 1, targetWidth);
      const beginY = divTrunc(ty * sourceHeight, targetHeight);
      const endY = divTrunc((ty + 1) * sourceHeight + targetHeight - 1, targetHeight);
      let value = input[beginY * sourceWidth + beginX]!;
      for (let y = beginY; y < endY; y++) {
        for (let x = beginX; x < endX; x++) {
          const sample = input[y * sourceWidth + x]!;
          value = reduceMax ? Math.max(value, sample) : Math.min(value, sample);
        }
      }
      output[ty * targetWidth + tx] = value === 0 ? 0 : value; // canonicalize-f32（-0→+0）
    }
  }
  return output;
}

/**
 * 全链 CPU 参考：floor mip 链逐档变窗缩减，返回各级输出（level 0 为输入副本）。
 * 偶数源窗口恰为 2×2，与 `hi_z_first_stage` 语义重合，因此单一公式覆盖整链。
 */
export function referenceHiZChain(input: Float32Array, width: number, height: number, mipLevelCount: number,
  reduceMax: boolean): readonly Float32Array[] {
  if (!Number.isSafeInteger(mipLevelCount) || mipLevelCount < 1 || mipLevelCount > hiZChainLevelCount(width, height)) {
    throw new Error("Hi-Z chain reference mipLevelCount is outside the complete chain.");
  }
  const levels: Float32Array[] = [input.slice()];
  for (let level = 1; level < mipLevelCount; level++) {
    const previous = levels[level - 1]!;
    levels.push(referenceHiZVariableReduce(previous, hiZChainLevelSize(width, level - 1), hiZChainLevelSize(height, level - 1),
      hiZChainLevelSize(width, level), hiZChainLevelSize(height, level), reduceMax));
  }
  return levels;
}

export function hiZChainLevelCount(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Hi-Z chain level count requires positive safe integers.");
  }
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** 生产管线选择：源尺寸偶×偶（窗口恰 2×2）走已认证锚定块快路径，否则走变窗内核。 */
export function usesAnchoredReduce(sourceWidth: number, sourceHeight: number): boolean {
  return sourceWidth % 2 === 0 && sourceHeight % 2 === 0;
}
