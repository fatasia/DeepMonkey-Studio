import type { ProbeUpdate } from "../lighting/probeClipmapPlan.js";

/**
 * GI 探针更新 kernel 的 DCIR 形式设计桩（R4 第二个 compute 消费点，本切片**未实现**）。
 * 设计依据：`docs/development.md` §5（探针迁 IR 的合同）与
 * `webgpu/webgpuProbeCaptureWgsl.ts` 现行手写实现（filterIrradiance / buildMip）。
 *
 * 设计（DCIR v1 形态，v0 缺以下 op，本切片不冒进）：
 * 1. **数据结构**：探针纹理 `texture_storage_2d_array<rgba16float>`（capture/filtered/mip 三张，
 *    尺寸 = grid.xy，层 = gridZ × levelCount，来源 `probeClipmapPlan` 的 profile/levels）。
 *    更新列表 = `array<ProbeUpdate>` storage buffer（`packProbeUpdates` 打包，16B/条）。
 * 2. **filterIrradiance → DCIR**：每更新一条线程（dispatch.x = updateCount），对 3×3 邻域做
 *    定序 gather（tap 顺序固定：x 内层、y 外层，同 HiZ 合同），逐通道累加后除以 9。
 *    需要的 v1 扩展：
 *    - `buffer-read` op（读 updates 列表，v0 无 storage buffer I/O）；
 *    - vec4 f32 算术 + `fdiv`（÷9 是舍入 op → **阈值档**，按 §4 声明 ULP 上限并逐输出记录，
 *      不得进入逐位档）；`clamp`/`min`（逐分量）可由现有 op 组合表达；
 *    - 纹理 op 扩展：`texture-2d-array-load` + rgba16float 存储目标（v0 仅 r32float 2D）。
 * 3. **buildMip → DCIR**：2×2 定序 gather 平均（sum*0.25 用乘法替代除法可减少一个舍入源，
 *    但仍为阈值档 op），同样依赖 2d-array/rgba16f 扩展。
 * 4. **确定性要点**：无 workgroup 共享内存/原子；每输出线程 gather 即满足白名单；
 *    rgba16f 目标写入的舍入（f32→f16）必须双后端一致——Dawn 与 ANGLE 均按 IEEE round-to-nearest,
 *    列入对拍用例（f16 舍入是 v1 对拍矩阵新增行）。
 * 5. **接线点**：`webgpuProbeCaptureAdapter` 的 encodeFilter/encodeMips 两段事务替换为 IR 内核，
 *    CaptureExecutor 事务边界（begin/commit/rollback）不变；IR 哈希入 performanceTelemetry。
 */

export const PROBE_IRRADIANCE_FILTER_NAME = "probe_irradiance_filter";

/** filterIrradiance 的固定 3×3 邻域 gather 顺序（x 内层、y 外层，确定性合同 §4.2）。 */
export const PROBE_FILTER_TAP_ORDER: readonly (readonly [number, number])[] = Object.freeze(
  [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => Object.freeze([x, y] as const))),
);

/** 复用 probeClipmap 计划类型的内核绑定合同（v1 实现时由发射器消费）。 */
export interface ProbeIrradianceFilterContract {
  /** dispatch.x = min(updateCount, arrayLength(updates))；v1 需 buffer-read 才能表达该 guard。 */
  readonly dispatch: "one-thread-per-update";
  readonly uniforms: readonly [
    { readonly name: "updateCount"; readonly type: "u32" },
    { readonly name: "gridZ"; readonly type: "u32" },
  ];
  readonly inputs: readonly ["storage-buffer: updates (ProbeUpdate[16B])", "texture-2d-array: captureInput (f32)"];
  readonly output: "texture-storage-2d-array: filteredOutput (rgba16float, write)";
  readonly reduction: { readonly taps: 9; readonly postOp: "componentwise-mul 1/9 (阈值档: fdiv 或 *0.25 类乘法替代)" };
}

/** 探针层索引：与 webgpuProbeCaptureWgsl.probeLayer 同语义（z + level*gridZ），纯 TS 可测。 */
export function probeClipmapLayerIndex(update: ProbeUpdate, gridZ: number): number {
  if (!Number.isSafeInteger(gridZ) || gridZ < 1) throw new Error("Probe layer index requires a positive gridZ.");
  if (!Number.isSafeInteger(update.level) || update.level < 0) throw new Error("Probe layer index requires a nonnegative level.");
  if (!Number.isSafeInteger(update.localCell[2]) || update.localCell[2]! < 0 || update.localCell[2]! >= gridZ) {
    throw new Error("Probe layer index requires localCell[2] within [0, gridZ).");
  }
  return update.localCell[2]! + update.level * gridZ;
}

/**
 * v0 桩：探针 filter/mip 内核需要 v1 op（buffer-read、vec4、2d-array、rgba16f、fdiv 阈值档），
 * 本切片不实现——调用总是抛出,禁止伪造"已迁移"状态（R4 前置切片范围声明）。
 */
export function buildProbeIrradianceFilterKernel(): never {
  throw new Error(
    "probe_irradiance_filter requires DCIR v1 ops (buffer-read, vec4 f32, texture-2d-array, rgba16float, "
    + "threshold-tier fdiv) — designed in shaderCompute/probeUpdateKernel.ts, not implemented in this slice.",
  );
}
