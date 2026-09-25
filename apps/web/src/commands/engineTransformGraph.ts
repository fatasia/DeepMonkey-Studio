import type { ModelTransform } from "@bim-studio/contracts";
import { SceneTransformGraph, SceneTransformGraphError, type SceneLocalTrs, type SceneMatrix4, type SceneQuaternion } from "@bim-studio/deep-engine/scene";

/**
 * 批 1 的 SceneTransformGraph 对接语义(最小可行切片):
 *
 * graph 是"经命令层的变换计算与校验通道"(calculation-authority channel):
 * 命令的全量 TRS 先经 graph `create/update`(有限性校验、四元数归一、sameLocalTransform
 * 增量判定、单调 stateRevision)与 `flush()`(权威 localMatrix/worldMatrix 计算),
 * 通过后才写回引擎 setter。Three 写回值保持命令原欧拉 TRS——欧拉↔四元数往返存在
 * 1e-16 级漂移与 2π wrap 风险,写回取命令原值保证与直调逐位等价(批 1 验收①③)。
 *
 * 刻意不在本批做的事(遗留,均记入设计文档后续批次):
 * - 节点按需创建、parent=null、跨命令仅作覆盖式 update:graph 不是常驻层级镜像。
 *   拦路虎:gizmo 拖拽流未收编(Three 是拖拽期权威)、undo 是整快照直改 Three、
 *   Three 层级未注入 graph。三者任一存在时,常驻镜像必然漂移。
 * - 因此命令保持全量 TRS 而非 Partial:全量覆盖下旧值不参与结果,无需基线同步;
 *   Partial 的"未指定字段保持不变"需要可信基线,待上述三者解决后引入。
 */

/** 变换命令的 graph 节点身份:模型根 / 图层对象各一个命名空间,与命令 target 一一对应。 */
export function transformGraphNodeId(modelId: string, layerId?: string): string {
  return layerId === undefined ? `model:${modelId}` : `layer:${modelId}:${layerId}`;
}

/**
 * 欧拉角(XYZ 内旋序,与 THREE.Euler 默认一致)→ 四元数。
 * 公式与 deep-engine SceneMutationGateway.eulerXyzQuaternion 逐项一致
 * (该函数未导出,此处按同一定义实现,由测试对拍 THREE.Quaternion.setFromEuler 保证)。
 */
export function eulerXyzToQuaternion(x: number, y: number, z: number): SceneQuaternion {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

export function modelTransformToSceneLocalTrs(transform: ModelTransform): SceneLocalTrs {
  return {
    kind: "trs",
    translation: [transform.position.x, transform.position.y, transform.position.z],
    rotation: eulerXyzToQuaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z),
    scale: [transform.scale.x, transform.scale.y, transform.scale.z],
  };
}

export interface TransformGraphApplyResult {
  /** graph 判定本次 update 有实际状态变化(新节点视为变化;同值覆盖为 false)。 */
  readonly changed: boolean;
  /** flush 后的 graph revision(仅 graph 自身状态变化时推进,与命令总线 revision 相互独立)。 */
  readonly graphRevision: number;
  /** 该节点的权威世界矩阵(parent=null 语义下等于局部矩阵)。 */
  readonly worldMatrix: SceneMatrix4;
}

/**
 * applier 私有的变换 graph 通道:按 engine 实例生命周期持有(引擎重建即随 applier 换桶重建,
 * 节点身份按命令重新注入,无跨引擎残留)。
 */
export class EngineTransformAuthoring {
  private readonly graph = new SceneTransformGraph();

  /**
   * 将一条全量 TRS 变换提交给 graph 权威通道:校验 + 增量判定 + 世界矩阵计算。
   * 非法值(非有限数、超限、零四元数)抛 SceneTransformGraphError,由调用方决定传播
   * (fail-fast 优于静默写坏值,对齐批 0 UnsupportedEngineEditCommandError 的显式失败哲学)。
   */
  applySetTransform(nodeId: string, transform: ModelTransform): TransformGraphApplyResult {
    const localTrs = modelTransformToSceneLocalTrs(transform);
    if (this.graph.has(nodeId)) {
      this.graph.update(nodeId, { localTransform: localTrs });
    } else {
      this.graph.create({ id: nodeId, localTransform: localTrs });
    }
    const flush = this.graph.flush();
    const change = flush.changes.find((entry) => entry.id === nodeId);
    const snapshot = change ? undefined : this.graph.getNode(nodeId);
    return {
      changed: change !== undefined,
      graphRevision: flush.revision,
      worldMatrix: change?.worldMatrix ?? snapshot!.worldMatrix,
    };
  }

  /** 测试与调试用:节点快照(权威 localTRS/worldMatrix/revision 记录)。 */
  node(nodeId: string) {
    return this.graph.getNode(nodeId);
  }

  get revision(): number {
    return this.graph.revision;
  }
}

export { SceneTransformGraphError };
