/**
 * I-C16 / T10 路径追踪参考核——**最小接口声明（本刀不实现核本体）**。
 *
 * == 裁定（诚实边界） ==
 * 仓内现状核查（2026-10-01）确认没有现成软件路径追踪核：
 * - `rayTrace.ts` 是 BVH 命中参考（closest-hit/occlusion，无弹射）；
 * - `probeReferenceIntegrator.ts` 是探针场一跳直射参考（无相机光线/BSDF 采样）；
 * - `apps/web/src/optimizer/lightmapBaker.ts` 显式声明避免离线 PT。
 * 按任务纪律"不重写核、不冒充已有能力"：本模块只冻结对拍期望生成器的接口形状，
 * 完整核（相机射线生成、Lambert/GGX BSDF 采样、Russian roulette、逐像素累积归并）
 * 由后续切片新建。实现义务：确定性（同 seed/序号逐位同输出，I-C17 显式 seed 模式）、
 * 纯 CPU、fail-closed 入参校验。
 */

/** 参考核输入场景的组件清单——全部已存在，核实现必须复用而非重建：
 * - 命中：`buildTracedScene`/`traceClosest`（rayTrace.ts，栈式 BVH，WGSL/Native 仲裁基准）
 * - 确定性采样：`createReferenceRng`/`uniformSphereDirection`（probeReferenceScene.ts）
 * - 黄金场景：`buildReferenceRoomScene`（房间+薄墙+门洞+天窗，T02 联测共享）
 */
export interface PathTraceReferenceKernel {
  /**
   * 单像素单样本路径积分。约定：
   * - `x`/`y` 像素坐标（整数，左上原点）；越界抛 RangeError；
   * - `sampleOrdinal` 批内样本序号（≥0）；`seed` 完整 u32（I-C17 显式 seed 模式）；
   * - 返回线性 RGB（非负有限），供 `PathTraceProductSession.advanceBatch` 的
   *   标量亮度聚合（通道均值）与 GPU 刀的实机对拍共用；
   * - 同 (x, y, sampleOrdinal, seed) 必须逐位同输出——这是对拍与收敛统计的前提。
   */
  traceSample(x: number, y: number, sampleOrdinal: number, seed: number):
    readonly [number, number, number];
}

/** 核工厂签名（后续切片实现）；本刀不提供实现，避免半成品核污染对拍基线。 */
export type PathTraceReferenceKernelFactory = (options: {
  readonly width: number;
  readonly height: number;
}) => PathTraceReferenceKernel;

/** 收敛统计的最小输入换算：样本 RGB → 标量亮度（通道均值，与参考积分器同口径）。 */
export function sampleBrightness(rgb: readonly [number, number, number]): number {
  return (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
}
