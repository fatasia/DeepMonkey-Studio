import type { SceneSnapshot } from "@bim-studio/contracts";

/** 渲染器重建时必须无损保留的场景与运行策略。 */
export interface RendererRecoveryState {
  scene: SceneSnapshot;
  readOnly: boolean;
  fastRuntime?: boolean;
  recoveryMessage?: string;
  temporaryBackend?: boolean;
  /**
   * J3-E：重建前编辑器瞬时动画播放头（秒）。SceneSnapshot 只含动画策略不含时刻，
   * 恢复路径缺省归零重放；设备丢失/WebGPU 回收/返回编辑器三类渲染器重建按此字段
   * 经 applyScene 第 9 参回 seek。缺省/非法值 = 归零，旧调用方行为逐位不变。
   */
  animationPlayheadSec?: number | undefined;
}
