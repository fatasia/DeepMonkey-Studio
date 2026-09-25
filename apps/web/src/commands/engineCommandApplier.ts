import type { ViewerEngine } from "../viewer/ViewerEngine";
import { sceneCommandBus, type EngineEditCommandApplier } from "./commandBus";
import type { EngineEditCommand, EngineEditCommandInput, SetTransformCommand, SetVisibilityCommand } from "./engineEditCommand";
import { EngineTransformAuthoring, transformGraphNodeId } from "./engineTransformGraph";

/**
 * applier 拒绝执行的命令(仅覆盖既有 setter 能表达的范围)。
 * 显式失败优于静默忽略:宁可中断编辑,不可丢字段装作成功。
 */
export class UnsupportedEngineEditCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEngineEditCommandError";
  }
}

/**
 * 桥接 applier:命令 → 既有 ViewerEngine setter 执行。
 *
 * 批 1(SetTransform 对接权威):setTransform 命令先经 EngineTransformAuthoring
 * (SceneTransformGraph 权威通道:校验/增量判定/世界矩阵计算/单调 revision),通过后
 * 原样调用既有 setter;写回值保持命令原欧拉 TRS,与直调逐位等价。
 * 既有 setter 的全部连带(updateCollisions/rebuildPhysicsBody/updateLayerState/
 * markShadowMapDirty/onModelChange)都在 engine 内部原样触发,不在此复制编排。
 */
export class ViewerEngineCommandApplier implements EngineEditCommandApplier {
  private readonly transforms = new EngineTransformAuthoring();

  constructor(private readonly engine: ViewerEngine) {}

  apply(command: EngineEditCommand): void {
    switch (command.kind) {
      case "setTransform":
        this.applySetTransform(command);
        return;
      case "setLayerState":
        this.applySetVisibility(command);
        return;
    }
  }

  private applySetTransform(command: SetTransformCommand): void {
    if (command.mode === "model") {
      this.applyModelSetTransform(command);
      return;
    }
    this.applySelectionSetTransform(command);
  }

  /**
   * mode "selection"(含批 0 缺省形态):作用于引擎当前选中,与直调
   * `engine.applySelectionTransform(command.transform)` 语义一致。
   */
  private applySelectionSetTransform(command: SetTransformCommand): void {
    // 与 applySelectionTransform 内部首条守卫等价的预检(均为公开 contract API):
    // 选中无效或锁定时静默返回,与直调一致;graph 不为无效命令记账。
    const selected = this.engine.getSelected();
    if (!selected || !this.engine.getSelectionTransform() || this.engine.isSelectionLocked()) return;
    // graph 权威通道先行:非法值在此抛错(fail-fast),不会写坏 Three。
    // 已知边界(如实声明):fragment 构件选中时 getSelectedLayerId 返回构件 id,本预检
    // 无法与普通图层对象区分,graph 会记账而 applySelectionTransform 内部守卫静默拒绝;
    // graph 节点是覆盖式通道,不产生跨命令污染,外部可见行为(Three/旁账/undo)与直调一致。
    const layerId = this.engine.getSelectedLayerId();
    const nodeId = transformGraphNodeId(selected.id, layerId && layerId !== "root" ? layerId : undefined);
    this.transforms.applySetTransform(nodeId, command.transform);
    this.engine.applySelectionTransform(command.transform);
  }

  /** mode "model":等价直调 `engine.setModelTransform(modelId, {position/rotation/scale 数组})`。 */
  private applyModelSetTransform(command: SetTransformCommand): void {
    const { modelId } = command.target;
    const { transform } = command;
    this.transforms.applySetTransform(transformGraphNodeId(modelId), transform);
    this.engine.setModelTransform(modelId, {
      position: [transform.position.x, transform.position.y, transform.position.z],
      rotation: [transform.rotation.x, transform.rotation.y, transform.rotation.z],
      scale: [transform.scale.x, transform.scale.y, transform.scale.z],
    });
  }

  private applySetVisibility(command: SetVisibilityCommand): void {
    const unsupported = Object.keys(command.patch).filter((key) => key !== "visible");
    if (unsupported.length > 0 || typeof command.patch.visible !== "boolean") {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch 含未支持字段 [${unsupported.join(", ") || "visible 类型非 boolean"}];` +
          "图层属性族(locked/name/opacity/color/deleted)命令化将在后续批次接入,请勿经命令层发送该 patch",
      );
    }
    const visible = command.patch.visible;
    // 与现状直调逐参数一致:图层级走 setLayerVisible,模型级走 setVisible。
    if (command.target.layerId !== undefined) {
      this.engine.setLayerVisible(command.target.modelId, command.target.layerId, visible);
    } else {
      this.engine.setVisible(command.target.modelId, visible);
    }
  }
}

/** applier 按 engine 实例缓存:引擎重建(后端切换/重载)时自然换桶,无全局可变绑定。 */
const applierCache = new WeakMap<ViewerEngine, ViewerEngineCommandApplier>();

/**
 * 生产接线入口:发命令 → 共享总线 → applier → 既有 setter。
 * engine 为空时静默跳过,与现状 `engine?.setLayerVisible(...)` 的 no-op 行为一致;
 * applier 抛错沿调用栈传播(与直调抛错等价),调用点的后续语句(如 onSetRevision)同样不会执行。
 */
export function dispatchEngineEditCommand(engine: ViewerEngine | undefined, input: EngineEditCommandInput): void {
  if (!engine) return;
  let applier = applierCache.get(engine);
  if (!applier) {
    applier = new ViewerEngineCommandApplier(engine);
    applierCache.set(engine, applier);
  }
  sceneCommandBus.publish(input, applier);
}
