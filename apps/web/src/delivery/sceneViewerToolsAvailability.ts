import type { SceneSnapshot } from "@bim-studio/contracts";

/**
 * 发布查看器工具级能力可用性。
 *
 * 判定依据是**场景编译字段完整性**：发布快照携带的字段能否被发布编译链路
 * 下发为运行包能力载荷（对应 compileSceneRuntimePackage 证据 compiledSceneFields
 * 里的 capability 标识）。未编译进包的能力在 Native/只读查看器里不可用，
 * 对应工具入口必须隐藏，而不是显示后点击报错。
 *
 * 语义边界（防误用）：
 * - 本判定与发布 payload 的 `degradedCapabilities` 无关——那是对象/字段降级
 *   路径清单（`report.items[].path`，如 `primitives[3]`），不是工具能力标识，
 *   不得拿它隐藏工具按钮（见台账 docs/active-task-recovery-ledger.md 第四轮语义判定）。
 * - 测量：`measurements` 是已有测量数据的存在性，不能反推交互测量工具是否
 *   可用；爆炸：纯引擎运行时能力，快照没有对应编译字段。这两类无法由快照
 *   形状诚实判定，不在本判定范围内，对应按钮保持显示，不伪造判定。
 */
export interface SceneViewerToolsAvailability {
  /** 快照携带剖切状态（`clipping` 字段）→ 发布编译随相机下发剖切平面载荷
   * （capability `deep.scene.section-plane.v1`）；未携带时剖切工具不可用。 */
  readonly clippingAvailable: boolean;
  /** 快照启用物理运行时（`physics.enabled`）→ 发布编译产出物理运行时载荷
   * （capability `deep.scene.physics-runtime.v1`）。enabled 但无可编译刚体的
   * 场景在发布编译阶段已被拒绝，不会成为发布快照，因此 enabled 即载荷在。
   * 当前工具坞没有物理专属按钮（物理经动态播放通道消费），该维度先随判定
   * 一并下发，供物理相关工具接入时消费。 */
  readonly physicsAvailable: boolean;
}

/** 从发布快照推导工具级能力可用性；纯函数，同一快照判定结果稳定。 */
export function sceneViewerToolsAvailability(snapshot: SceneSnapshot): SceneViewerToolsAvailability {
  return {
    clippingAvailable: snapshot.clipping !== undefined,
    physicsAvailable: snapshot.physics?.enabled === true,
  };
}
