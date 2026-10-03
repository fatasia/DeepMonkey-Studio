/**
 * I-C16 / T10 路径追踪参考核接口。
 *
 * `createPathTraceCpuKernel` 提供单 BLAS、Lambert/GGX 导体、多跳 CPU 实现；
 * `PathTraceCpuRender` 持有真实像素累积并消费产品会话与 HDR 编码。
 * TLAS 动态实例、生产材质全族、GPU 和产品 UI 不在该 CPU 子集。
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
   * - `sampleOrdinal` 绝对样本序号（≥0，不因分批重置）；`seed` 完整 u32；
   * - 返回线性 RGB（非负有限），供 `PathTraceProductSession.advanceBatch` 的
   *   标量亮度聚合（通道均值）与 GPU 刀的实机对拍共用；
   * - 同 (x, y, sampleOrdinal, seed) 必须逐位同输出——这是对拍与收敛统计的前提。
   */
  traceSample(x: number, y: number, sampleOrdinal: number, seed: number):
    readonly [number, number, number];
}

/** 注入场景/相机后供消费者使用的核工厂签名。 */
export type PathTraceReferenceKernelFactory = (options: {
  readonly width: number;
  readonly height: number;
}) => PathTraceReferenceKernel;

/** 收敛统计的最小输入换算：样本 RGB → 标量亮度（通道均值，与参考积分器同口径）。 */
export function sampleBrightness(rgb: readonly [number, number, number]): number {
  return (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
}
