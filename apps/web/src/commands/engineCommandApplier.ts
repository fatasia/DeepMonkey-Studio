import type { ViewerEngine } from "../viewer/ViewerEngine";
import { sceneCommandBus, type EngineEditCommandApplier } from "./commandBus";
import type { EngineEditCommand, EngineEditCommandInput, SetGlobalLightingCommand, SetMaterialStateCommand, SetSceneEnvironmentCommand, SetTransformCommand, SetVisibilityCommand } from "./engineEditCommand";
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

/** 批 2 SetVisibility 支持的 patch 字段;其余字段(opacity/color/material/transform/deleted)按批次接入。 */
const SUPPORTED_LAYER_STATE_FIELDS = new Set(["visible", "locked", "name"]);

/**
 * 桥接 applier:命令 → 既有 ViewerEngine setter 执行。
 *
 * 批 1(SetTransform 对接权威):setTransform 命令先经 EngineTransformAuthoring
 * (SceneTransformGraph 权威通道:校验/增量判定/世界矩阵计算/单调 revision),通过后
 * 原样调用既有 setter;写回值保持命令原欧拉 TRS,与直调逐位等价。
 * 既有 setter 的全部连带(updateCollisions/rebuildPhysicsBody/updateLayerState/
 * markShadowMapDirty/onModelChange)都在 engine 内部原样触发,不在此复制编排。
 *
 * 批 2(SetVisibility 收编):setLayerState 支持 visible/locked/name 三字段与
 * selection 模式;每个字段原样转交对应既有 setter(可见性/锁定按 target.layerId
 * 有无与调用点直调逐参数一致;重命名沿用引擎仅有的 selection 作用域 setter)。
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
      case "setMaterialState":
        this.applySetMaterial(command);
        return;
      case "setSceneEnv":
        this.engine.setSceneEnvironment(command.environment);
        return;
      case "setLighting":
        this.engine.setGlobalLighting(command.lighting);
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
    //
    // 已知边界(批 2 复评,如实声明):fragment 构件选中时 applySelectionTransform 内部守卫
    // (selectedFragmentNodeId 非 root → 静默 return)会拒绝本次变换,而本预检无法提前识别,
    // graph 已记账——即"记账但声明 degraded"的降级形态。批 2 评估结论:引擎没有可只读使用的
    // 判别查询——selectedFragmentNodeId 为 protected;getSelectedLayerId() 把 fragment 构件 id
    // 与普通图层对象 id 混在同一返回口;getSelectionScope() 是拾取粒度偏好(model|component),
    // 与"当前选中是否构件"无关;getSelectedComponentRecord()/getSelectionProperties() 只覆盖
    // layerObjects 或展示字符串,其 undefined 同样覆盖"模型根选中(可变换)",不构成判别子。
    // 该降级的外部等价性:graph 节点是覆盖式通道(无跨命令污染),构件选中下 setter 静默拒绝
    // 与直调逐点一致(Three/旁账/undo/连带均不变);后续批次在引擎暴露选中种类查询后收口。
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

  /**
   * 批 3(setMaterialState 收编):patch 原样转交既有材质 setter——引擎内部的
   * mergeMaterialPatch 合并、restoreModelEffectMaterials、updateLayerState、
   * rebuildModelEffects、markShadowMapDirty、onModelChange 连带全部原样触发;
   * 锁定/未选中静默 no-op 与直调一致(材质无 graph 前置校验通道,不 fail-fast)。
   */
  private applySetMaterial(command: SetMaterialStateCommand): void {
    if (Object.keys(command.patch).length === 0) {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch 为空;材质命令必须携带至少一个外观字段`,
      );
    }
    if (command.mode === "model") {
      this.engine.setModelMaterial(command.target.modelId, command.patch);
      return;
    }
    this.engine.setSelectionMaterial(command.patch);
  }

  private applySetVisibility(command: SetVisibilityCommand): void {
    const unsupported = Object.keys(command.patch).filter((key) => !SUPPORTED_LAYER_STATE_FIELDS.has(key));
    if (unsupported.length > 0) {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch 含未支持字段 [${unsupported.join(", ")}];` +
          "批 2 支持 visible/locked/name,opacity/color/material/transform/deleted 命令化将在后续批次接入,请勿经命令层发送该 patch",
      );
    }
    const { visible, locked, name } = command.patch;
    if (visible === undefined && locked === undefined && name === undefined) {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch 无有效字段(字段值不可为 undefined);请至少携带 visible/locked/name 之一`,
      );
    }
    if (visible !== undefined && typeof visible !== "boolean") {
      throw new UnsupportedEngineEditCommandError(`命令 ${command.id}(${command.kind})的 patch.visible 类型非 boolean`);
    }
    if (locked !== undefined && typeof locked !== "boolean") {
      throw new UnsupportedEngineEditCommandError(`命令 ${command.id}(${command.kind})的 patch.locked 类型非 boolean`);
    }
    if (name !== undefined && typeof name !== "string") {
      throw new UnsupportedEngineEditCommandError(`命令 ${command.id}(${command.kind})的 patch.name 类型非 string`);
    }
    if (name !== undefined && command.mode !== "selection") {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch.name 仅支持 selection 模式(引擎重命名 setter renameSelection 只作用于当前选中);` +
          "target 模式重命名将在引擎提供按 id 定位的重命名 setter 后接入",
      );
    }
    if (locked !== undefined && command.mode === "selection") {
      throw new UnsupportedEngineEditCommandError(
        `命令 ${command.id}(${command.kind})的 patch.locked 不支持 selection 模式(引擎无选中作用域的锁定 setter);` +
          "请在调用点按图层/模型分发后以 target 模式(layerId 有无)发送",
      );
    }
    // 逐字段原样转交既有 setter;多字段按 name → locked → visible 的固定顺序(与引擎恢复路径
    // applyLayerStates 对这三字段的既有编排一致)。当前 UI 写点均为单字段 patch。
    if (name !== undefined) this.engine.renameSelection(name);
    if (locked !== undefined) {
      // 与现状直调逐参数一致:带 layerId 走 setLayerLocked(含 layerId === "root" 时 setter 内部
      // 转委 setModelLocked 的既有语义),模型级走 setModelLocked。
      if (command.target.layerId !== undefined) {
        this.engine.setLayerLocked(command.target.modelId, command.target.layerId, locked);
      } else {
        this.engine.setModelLocked(command.target.modelId, locked);
      }
    }
    if (visible !== undefined) {
      // 与现状直调逐参数一致:selection 模式走 setSelectionVisible(其内部分发 fragment 构件/
      // 模型根/图层对象的既有语义);target 模式图层级走 setLayerVisible,模型级走 setVisible。
      if (command.mode === "selection") {
        this.engine.setSelectionVisible(visible);
      } else if (command.target.layerId !== undefined) {
        this.engine.setLayerVisible(command.target.modelId, command.target.layerId, visible);
      } else {
        this.engine.setVisible(command.target.modelId, visible);
      }
    }
  }
  /** 测试与审计用:graph 通道节点快照(验证 fragment 降级路径"记账"侧的既有事实)。 */
  transformNode(nodeId: string) {
    return this.transforms.node(nodeId);
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
