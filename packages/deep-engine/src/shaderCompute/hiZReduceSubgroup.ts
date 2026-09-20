import type { DcirKernel, DcirNode } from "./types.js";
import { KernelBuilder } from "./kernel.js";
import { hiZFirstStageTargetSize } from "./hiZReduce.js";

/**
 * HiZ 深度缩减第一档的 subgroup 变体：`hi_z_first_stage_subgroup`（R2 波次2 快赢）。
 * 与已认证的 2×2 内核（hi_z_first_stage）输出逐值一致（含 ±0 折叠/并列/+inf 边界），
 * 但归约用 DCIR 新 op `subgroup-min`/`subgroup-max`（f32-only）在 subgroup 内聚合。
 *
 * == subgroup 语义合同（WGSL 规范口径，禁止含糊） ==
 * 1. 活跃集：WGSL subgroupMin/Max 只对「活跃 lane」归约。本内核所有节点在 guard return
 *    之前以直线 let 展开，subgroup 内所有 lane 必然同序执行全部归约（uniformity 合同），
 *    活跃集恒等于整个 subgroup，不存在提前退出造成的真·inactive lane。
 * 2. inactive-lane 吸收值合同：不在某次归约目标集内的 lane，其操作数用 select 预掩码成
 *    「吸收值」——subgroup-min 吸收值 = +Inf，subgroup-max 吸收值 = -Inf（IEEE 恒等元，
 *    min/max 对 ±Inf 精确，吸收 lane 不影响结果）。源外 texel tap（越界）同法吸收，
 *    等价于 2×2 内核的「回退累加值」排除语义。目标集全部被吸收的归约（subgroupSize<32
 *    时的死归约节点）结果为吸收值本身——良定义、确定，且下游 select 链永不选中它。
 * 3. 布局合同：workgroup (2,16)=32 lane，lane 线性序 li=y*2+x（WebGPU 规范保证 subgroup
 *    由「连续递增的 local invocation index」构成，x 最快）。2×2 texel 的 4 个 tap 占据
 *    连续 4 个 lane 块 [4j,4j+4)。消费侧必须保证 4 整除 device subgroup size（4|s），
 *    则 texel 块永不跨 subgroup，s=4/8/16/32… 布局全部正确且语义与 s 无关。
 *    横向 = H 对 {4j,4j+1}/{4j+2,4j+3} 归约，纵向 = V 对左列 {4j,4j+2} 归约，
 *    2×2 = fold(H_top, H_bottom) 经 V 聚合，与 2×2 参考逐值一致。
 * 4. 值级确定性：禁 NaN 合同下，精确 f32 的 min/max 可结合可交换，归约树形状不影响值；
 *    并列取同值；±0 并列择向由 canonicalize-f32 折叠（与 2×2 内核同一防线）。
 * 5. 单写者：仅 texel 左上 lane（lane%4==0）过 guard 写出，无冗余竞态写。
 * 6. 后端：WGSL 发射声明 `requires subgroups;`（不支持设备由 features 探测拒绝）；
 *    GLSL ES 3.0 无 subgroup 能力，发射器 fail-closed（emitGlsl）。
 * min/max 在 IR 层特化为两个内核（沿用 R2 uniform 打包 quirk 的规避结论）。
 */

export const HI_Z_FIRST_STAGE_SUBGROUP_NAME = "hi_z_first_stage_subgroup";

/** subgroup 变体 workgroup 尺寸：2×16（布局合同见头注释第 3 条）。 */
export const HI_Z_SUBGROUP_WORKGROUP_SIZE = [2, 16] as const;

const LANES_PER_WORKGROUP = 32;
const TEXEL_ROWS_PER_WORKGROUP = 8;

/** dispatch 尺寸：x 每 texel 列一个 workgroup，y 每 8 个 texel 行一个 workgroup。 */
export function hiZFirstStageSubgroupDispatchSize(sourceWidth: number, sourceHeight: number): readonly [number, number] {
  const [tw, th] = hiZFirstStageTargetSize(sourceWidth, sourceHeight);
  return [tw, Math.ceil(th / TEXEL_ROWS_PER_WORKGROUP)];
}

export function buildHiZFirstStageSubgroupKernel(reduceMax: boolean): DcirKernel {
  const b = new KernelBuilder();
  const push = (node: DcirNode): string => b.push(node);
  const litU32 = (id: string, value: number): string => push({ id, type: "u32", op: "literal", value });
  const litBool = (id: string, value: boolean): string => push({ id, type: "bool", op: "literal", value });
  const binInt = (id: string, op: "iadd" | "imul" | "idiv" | "imin" | "isub", a: string, c: string): string =>
    push({ id, type: "u32", op, inputs: [a, c] });
  const cmp = (id: string, op: "ieq" | "ult", a: string, c: string): string => push({ id, type: "bool", op, inputs: [a, c] });
  const selF = (id: string, falseValue: string, trueValue: string, condition: string): string =>
    push({ id, type: "f32", op: "select", inputs: [falseValue, trueValue, condition] });
  const andBool = (id: string, a: string, c: string): string =>
    push({ id, type: "bool", op: "select", inputs: [litBool(`${id}_f`, false), a, c] });
  const orBool = (id: string, a: string, c: string): string =>
    push({ id, type: "bool", op: "select", inputs: [c, litBool(`${id}_t`, true), a] });
  const sub = (id: string, input: string): string =>
    push({ id, type: "f32", op: reduceMax ? "subgroup-max" : "subgroup-min", input });

  const gid = push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const tx = push({ id: "tx", type: "u32", op: "component", input: gid, component: 0 });
  const ty = push({ id: "ty", type: "u32", op: "component", input: gid, component: 1 });
  const src = push({ id: "sourceSize", type: "vec2u", op: "kernel-uniform", uniform: "sourceSize" });
  const dst = push({ id: "targetSize", type: "vec2u", op: "kernel-uniform", uniform: "targetSize" });
  const sw = push({ id: "sw", type: "u32", op: "component", input: src, component: 0 });
  const sh = push({ id: "sh", type: "u32", op: "component", input: src, component: 1 });
  const tw = push({ id: "tw", type: "u32", op: "component", input: dst, component: 0 });
  const th = push({ id: "th", type: "u32", op: "component", input: dst, component: 1 });

  const lane = push({ id: "lane", type: "u32", op: "subgroup-invocation-id" });
  const one = litU32("one", 1);
  const two = litU32("two", 2);
  const four = litU32("four", 4);
  // lane 的 texel 块基（subgroup 内相对序）：pairBase=(lane/2)*2，quadBase=(lane/4)*4。
  const pairBase = binInt("pairBase", "imul", binInt("pairHalf", "idiv", lane, two), two);
  const quadBase = binInt("quadBase", "imul", binInt("quadFourth", "idiv", lane, four), four);
  const isTopLeft = cmp("isTopLeft", "ieq", quadBase, lane);

  const ux = binInt("ux", "idiv", tx, two);
  const uy = binInt("uy", "idiv", ty, two);
  const inside = andBool("inside", cmp("inx", "ult", ux, tw), cmp("iny", "ult", uy, th));
  const guard = andBool("guard", inside, isTopLeft);

  // 取数坐标 clamp 入界（texel-load 界内合同）；源外 tap 由吸收值排除。
  const swm1 = binInt("swm1", "isub", sw, one);
  const shm1 = binInt("shm1", "isub", sh, one);
  const cx = binInt("cx", "imin", tx, swm1);
  const cy = binInt("cy", "imin", ty, shm1);
  const vx = cmp("vx", "ult", tx, sw);
  const vy = cmp("vy", "ult", ty, sh);
  const valid = andBool("valid", vx, vy);
  const coords = push({ id: "coords", type: "vec2u", op: "make-vec2u", inputs: [cx, cy] });
  const sample = push({ id: "sample", type: "f32", op: "texel-load", coords });
  // 吸收值字面量：min=+Inf / max=-Inf（头注释第 2 条合同）。
  const absorber = push({ id: "absorber", type: "f32", op: "literal", value: reduceMax ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY });
  const contrib = selF("contrib", absorber, sample, valid);

  // 每 texel 块 j（ll 空间基 4j）：H_top{4j,4j+1}、H_bottom{4j+2,4j+3}、V 左列{4j,4j+2}。
  // s<32 时高位块的归约全吸收（死值，select 链按 lane/4 选取永不命中，见头注释第 2 条）。
  const texelReductions: string[] = [];
  for (let j = 0; j < TEXEL_ROWS_PER_WORKGROUP; j++) {
    const suffix = `${j}`;
    const base = litU32(`b${suffix}`, 4 * j);
    const baseBottom = litU32(`bb${suffix}`, 4 * j + 2);
    const predTop = cmp(`pT${suffix}`, "ieq", pairBase, base);
    const maskedTop = selF(`mT${suffix}`, absorber, contrib, predTop);
    const reducedTop = sub(`rT${suffix}`, maskedTop);
    const predBottom = cmp(`pB${suffix}`, "ieq", pairBase, baseBottom);
    const maskedBottom = selF(`mB${suffix}`, absorber, contrib, predBottom);
    const reducedBottom = sub(`rB${suffix}`, maskedBottom);
    const predVertical = orBool(`pV${suffix}`, predTop, predBottom);
    const laneHorizontal = selF(`oV${suffix}`, reducedBottom, reducedTop, predTop);
    const maskedVertical = selF(`mV${suffix}`, absorber, laneHorizontal, predVertical);
    texelReductions.push(sub(`rV${suffix}`, maskedVertical));
  }
  // select 链按本 lane 的 texel 块号取本 texel 的 V 归约结果（所有 lane 同序执行全链）。
  const laneTexel = binInt("laneTexel", "idiv", lane, four);
  let value = texelReductions[0]!;
  for (let j = 1; j < TEXEL_ROWS_PER_WORKGROUP; j++) {
    value = selF(`pick${j}`, value, texelReductions[j]!, cmp(`hit${j}`, "ieq", litU32(`t${j}`, j), laneTexel));
  }
  const canonical = push({ id: "value", type: "f32", op: "canonicalize-f32", input: value });
  const outCoords = push({ id: "outCoords", type: "vec2u", op: "make-vec2u", inputs: [ux, uy] });
  return {
    name: HI_Z_FIRST_STAGE_SUBGROUP_NAME,
    textureIo: "r32float",
    workgroupSize: [...HI_Z_SUBGROUP_WORKGROUP_SIZE],
    uniforms: [
      { name: "sourceSize", type: "vec2u" },
      { name: "targetSize", type: "vec2u" },
    ],
    nodes: b.nodes(),
    guard,
    output: { coords: outCoords, value: canonical },
  };
}

/**
 * CPU 参考实现：按「连续 lane 块 = subgroup」的布局合同逐 workgroup/逐 subgroup 结构化
 * 模拟（H 对 → V 左列 → canonicalize），布局不变量（texel 块不跨 subgroup）直接由
 * 4|subgroupSize 保证并在此显式校验。输出与 referenceHiZFirstStage 逐位一致（vitest 契约）。
 */
export function referenceHiZFirstStageSubgroup(input: Float32Array, sourceWidth: number, sourceHeight: number,
  reduceMax: boolean, subgroupSize: number): Float32Array {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
    || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Hi-Z subgroup first stage requires positive safe integer source dimensions.");
  }
  // 布局合同：4|s ⇒ texel 块（4 lane）永不跨 subgroup；s=4/8/16/32… 语义与 s 无关。
  if (!Number.isSafeInteger(subgroupSize) || subgroupSize < 4 || subgroupSize % 4 !== 0) {
    throw new Error("Hi-Z subgroup first stage requires subgroupSize to be a positive multiple of 4.");
  }
  const [tw, th] = hiZFirstStageTargetSize(sourceWidth, sourceHeight);
  const absorber = reduceMax ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const fold = (a: number, c: number): number => (reduceMax ? Math.max(a, c) : Math.min(a, c));
  const output = new Float32Array(tw * th);
  for (let wx = 0; wx < tw; wx++) {
    for (let wy = 0; wy * TEXEL_ROWS_PER_WORKGROUP < th; wy++) {
      const contrib = new Array<number>(LANES_PER_WORKGROUP);
      for (let li = 0; li < LANES_PER_WORKGROUP; li++) {
        const px = wx * 2 + (li & 1);
        const py = wy * 16 + (li >> 1);
        contrib[li] = px < sourceWidth && py < sourceHeight ? input[py * sourceWidth + px]! : absorber;
      }
      for (let chunkStart = 0; chunkStart < LANES_PER_WORKGROUP; chunkStart += subgroupSize) {
        for (let block = 0; block * 4 < subgroupSize && chunkStart + block * 4 < LANES_PER_WORKGROUP; block++) {
          const base = chunkStart + block * 4;
          const hTop = fold(contrib[base]!, contrib[base + 1]!);          // H：上边对
          const hBottom = fold(contrib[base + 2]!, contrib[base + 3]!);   // H：下边对
          const reduced = fold(hTop, hBottom);                            // V：左列聚合
          const targetRow = wy * TEXEL_ROWS_PER_WORKGROUP + base / 4;
          if (targetRow < th) output[targetRow * tw + wx] = reduced === 0 ? 0 : reduced; // canonicalize-f32
        }
      }
    }
  }
  return output;
}
