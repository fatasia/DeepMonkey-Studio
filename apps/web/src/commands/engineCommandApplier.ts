import type { ViewerEngine } from "../viewer/ViewerEngine";
import { sceneCommandBus, type EngineEditCommandApplier } from "./commandBus";
import type { EngineEditCommand, EngineEditCommandInput, SetTransformCommand, SetVisibilityCommand } from "./engineEditCommand";

/**
 * applier 拒绝执行的命令(批 0 仅覆盖既有 setter 能表达的范围)。
 * 显式失败优于静默忽略:宁可中断编辑,不可丢字段装作成功。
 */
export class UnsupportedEngineEditCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEngineEditCommandError";
  }
}

/**
 * 桥接 applier(批 0):命令 → 既有 ViewerEngine setter 原样执行,行为零变化。
 * 现有 setter 的全部连带(updateCollisions/rebuildPhysicsBody/updateLayerState/
 * markShadowMapDirty/onModelChange)都在 engine 内部原样触发,不在此复制编排。
 */
export class ViewerEngineCommandApplier implements EngineEditCommandApplier {
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
    // 既有 applySelectionTransform 原样转交(含锁定/图层选中守卫,目标态由其内部决定)。
    this.engine.applySelectionTransform(command.transform);
  }

  private applySetVisibility(command: SetVisibilityCommand): void {
    const unsupported = Object.keys(command.patch).filter((key) => key !== "visible");
    if (unsupported.length > 0 || typeof command.patch.visible !== "boolean") {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch 含批 0 未支持字段 [${unsupported.join(", ") || "visible 类型非 boolean"}];` +
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
