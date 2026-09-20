import type { DcirKernel, DcirNode } from "./types.js";
import { KernelBuilder } from "./kernel.js";

/**
 * HiZ 深度缩减第一档：2×2 锚定块 min/max 归约（r32float → r32float）。
 * 单一 DCIR 源 → WGSL（WebGPU/Native wgpu）+ GLSL（WebGL2 fragment 降级）。
 * 确定性要点：种子 → 角(1,0) → 角(0,1) → 角(1,1) 的定序归约；取数坐标先 clamp 到界内，
 * 无效角用 select 回退到当前累加值（等效中性元，无需 ±inf）；输出 canonicalize 折叠 -0。
 * 模式（min/max）在 IR 层特化而非运行时 uniform：真机发现 ANGLE/D3D11 对"两个 uvec2 后跟
 * 一个 uint"的 uniform 打包存在 quirk（uint 恒读 0），特化后 kernel 仅剩两个 uvec2 uniform
 * （双端真机证实正确）；这与生产 HiZ 用 pipeline 常量区分 min/max 的做法一致。
 * 语义分歧声明：与生产 `HI_Z_REDUCE_WGSL` 的变窗公式在 NPOT 首档不逐位相同（设计 §5/§8）。
 */

export const HI_Z_FIRST_STAGE_NAME = "hi_z_first_stage";

/** 目标尺寸合同：tw=ceil(sw/2), th=ceil(sh/2)；保证种子角 (2tx, 2ty) 必在界内。 */
export function hiZFirstStageTargetSize(sourceWidth: number, sourceHeight: number): readonly [number, number] {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Hi-Z first stage source dimensions must be positive safe integers.");
  }
  return [Math.ceil(sourceWidth / 2), Math.ceil(sourceHeight / 2)];
}

export function buildHiZFirstStageKernel(reduceMax: boolean): DcirKernel {
  const b = new KernelBuilder();
  const push = (node: DcirNode): string => b.push(node);
  const litU32 = (id: string, value: number): string => push({ id, type: "u32", op: "literal", value });
  const litBool = (id: string, value: boolean): string => push({ id, type: "bool", op: "literal", value });
  const binInt = (id: string, op: "iadd" | "isub" | "imul" | "idiv" | "imin" | "imax", a: string, c: string): string =>
    push({ id, type: "u32", op, inputs: [a, c] });
  const cmp = (id: string, op: "ieq" | "ult", a: string, c: string): string => push({ id, type: "bool", op, inputs: [a, c] });
  const sel = (id: string, falseValue: string, trueValue: string, condition: string): string =>
    push({ id, type: "u32", op: "select", inputs: [falseValue, trueValue, condition] });
  const selF = (id: string, falseValue: string, trueValue: string, condition: string): string =>
    push({ id, type: "f32", op: "select", inputs: [falseValue, trueValue, condition] });

  const gid = push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const tx = push({ id: "tx", type: "u32", op: "component", input: gid, component: 0 });
  const ty = push({ id: "ty", type: "u32", op: "component", input: gid, component: 1 });
  const src = push({ id: "sourceSize", type: "vec2u", op: "kernel-uniform", uniform: "sourceSize" });
  const dst = push({ id: "targetSize", type: "vec2u", op: "kernel-uniform", uniform: "targetSize" });
  const sw = push({ id: "sw", type: "u32", op: "component", input: src, component: 0 });
  const sh = push({ id: "sh", type: "u32", op: "component", input: src, component: 1 });
  const tw = push({ id: "tw", type: "u32", op: "component", input: dst, component: 0 });
  const th = push({ id: "th", type: "u32", op: "component", input: dst, component: 1 });
  const inside = selBool("inside", cmp("inx", "ult", tx, tw), cmp("iny", "ult", ty, th));
  const one = litU32("one", 1);
  const two = litU32("two", 2);
  const swm1 = binInt("swm1", "isub", sw, one);
  const shm1 = binInt("shm1", "isub", sh, one);
  const bx = binInt("bx", "imul", tx, two);
  const by = binInt("by", "imul", ty, two);
  const bx1 = binInt("bx1", "iadd", bx, one);
  const by1 = binInt("by1", "iadd", by, one);
  const vx0 = cmp("vx0", "ult", bx, sw);
  const vy0 = cmp("vy0", "ult", by, sh);
  const vx1 = cmp("vx1", "ult", bx1, sw);
  const vy1 = cmp("vy1", "ult", by1, sh);
  // 全部取数坐标先 clamp 到界内（GLSL texelFetch 越界未定义；WGSL 侧同构化）。
  const cx0 = sel("cx0", swm1, bx, vx0);
  const cy0 = sel("cy0", shm1, by, vy0);
  const cx1 = sel("cx1", swm1, bx1, vx1);
  const cy1 = sel("cy1", shm1, by1, vy1);
  const c00 = push({ id: "c00", type: "vec2u", op: "make-vec2u", inputs: [cx0, cy0] });
  const c10 = push({ id: "c10", type: "vec2u", op: "make-vec2u", inputs: [cx1, cy0] });
  const c01 = push({ id: "c01", type: "vec2u", op: "make-vec2u", inputs: [cx0, cy1] });
  const c11 = push({ id: "c11", type: "vec2u", op: "make-vec2u", inputs: [cx1, cy1] });
  const load = (id: string, coords: string): string => push({ id, type: "f32", op: "texel-load", coords });
  const s00 = load("s00", c00);
  const s10 = load("s10", c10);
  const s01 = load("s01", c01);
  const s11 = load("s11", c11);
  // 定序归约：v1 → v2 → v3；无效角回退当前累加值（fmin(v,v) 精确，无舍入）。
  const a1 = selF("a1", s00, s10, vx1);
  const v1 = reduceStep("v1", s00, a1);
  const a2 = selF("a2", v1, s01, vy1);
  const v2 = reduceStep("v2", v1, a2);
  const valid11 = selBool("valid11", vx1, vy1);
  const a3 = selF("a3", v2, s11, valid11);
  const v3 = reduceStep("v3", v2, a3);
  const value = push({ id: "value", type: "f32", op: "canonicalize-f32", input: v3 });
  return {
    name: HI_Z_FIRST_STAGE_NAME,
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

  function selBool(id: string, cond: string, cond2: string): string {
    return push({ id, type: "bool", op: "select", inputs: [litBool(`${id}_f`, false), cond, cond2] });
  }
  function reduceStep(id: string, v: string, a: string): string {
    return push({ id, type: "f32", op: reduceMax ? "fmax" : "fmin", inputs: [v, a] });
  }
}

/** CPU 参考实现：与 IR 相同的 clamp 取数 + 定序归约 + canonicalize（Math.min/max 对精确 f32 值无舍入）。 */
export function referenceHiZFirstStage(input: Float32Array, sourceWidth: number, sourceHeight: number, reduceMax: boolean): Float32Array {
  const [tw, th] = hiZFirstStageTargetSize(sourceWidth, sourceHeight);
  const sample = (x: number, y: number): number =>
    input[Math.min(y, sourceHeight - 1) * sourceWidth + Math.min(x, sourceWidth - 1)]!;
  const output = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const bx = tx * 2, by = ty * 2;
      let value = sample(bx, by);
      const step = (x: number, y: number, valid: boolean): void => {
        const candidate = valid ? sample(x, y) : value;
        value = reduceMax ? Math.max(value, candidate) : Math.min(value, candidate);
      };
      step(bx + 1, by, bx + 1 < sourceWidth);
      step(bx, by + 1, by + 1 < sourceHeight);
      step(bx + 1, by + 1, bx + 1 < sourceWidth && by + 1 < sourceHeight);
      // canonicalize-f32：+0 折叠 -0（IEEE 单次舍入下 -0 + (+0) = +0），其余位型不变。
      output[ty * tw + tx] = value === 0 ? 0 : value;
    }
  }
  return output;
}

const XorShiftSeedBase = 0x9e3779b9;

function xorshift32(state: number): number {
  let x = state | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x | 0;
}

export interface HiZInputOptions {
  /** "denormal" 案例填充 f32 denormal（阈值档风险探针，见设计 §4.4）。 */
  readonly denormal?: boolean;
}

/** 确定性合成输入：xorshift32 构造 [0,1) 精确 f32，并注入 ±0/相等值/1.0/+inf 等并列与哨兵。 */
export function generateHiZInput(seed: number, sourceWidth: number, sourceHeight: number, options: HiZInputOptions = {}): Float32Array {
  const count = sourceWidth * sourceHeight;
  const input = new Float32Array(count);
  let state = (seed ^ XorShiftSeedBase) | 0;
  for (let index = 0; index < count; index++) {
    state = xorshift32(state);
    if (options.denormal) {
      // 指数 0、尾数非零：f32 denormal，可能被 D3D/ANGLE flush-to-zero，允许阈值档差异。
      new Uint32Array(input.buffer)[index] = ((state >>> 8) & 0x007f_ffff) + 1;
    } else {
      input[index] = (state >>> 8 & 0x00ff_ffff) / 0x0100_0000;
    }
  }
  if (!options.denormal && count >= 8) {
    input[0] = 0;                        // +0
    input[1] = -0;                       // -0：min/max 并列的 ±0 择向风险
    input[2] = 1;                        // 上界
    input[3] = 0.5;
    input[4] = 0.5;                      // 精确相等并列
    input[5] = Number.POSITIVE_INFINITY; // 哨兵（min/max 对 inf 精确）
    input[6] = 0.25;
    input[7] = 0.25;                     // 相邻重复，触发跨角并列
  }
  return input;
}
