import { SceneMutationGateway, type SceneMutationCommandParser } from "@bim-studio/deep-engine/scene";
import type { SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import type { SceneLocalTransform, SceneTransformFlushResult, SceneTransformNodeSnapshot } from "@bim-studio/deep-engine/scene";
import type { SceneCommand, SceneCommandTransactionDriver } from "@bim-studio/scene-sdk";
import type { PrimitiveState } from "@bim-studio/contracts";
import { primitiveStateFromCommand, modelTransformFromSceneLocal, type ScenePrimitiveOwnerPort, type ScenePrimitiveSnapshot } from "./ScenePrimitiveOwnerPort";
import { assertCameraSceneScope, type SceneCameraFlyIntent, type SceneCameraPort, type SceneCameraSnapshot } from "./SceneCameraPort";
import type { SceneReferenceCleanupPort, SceneReferenceSnapshot } from "./SceneReferenceCleanupPort";

interface InverseNode {
  readonly nodeId: string;
  readonly parent: string | null;
  readonly siblingIndex: number;
  readonly transform: SceneLocalTransform;
  readonly hidden: boolean;
}

/**
 * 逆算子:update=create/delete 之外的图编辑(create→整树移除;删除→按捕获快照整树重建),
 * owner 携带 port 图元 before 态供回滚恢复;primitive=material.set 等纯 port 态变更;
 * camera=相机命令的宿主 pose before 态;delete.references=宿主引用容器 before 态(第三批)。
 */
type InverseEntry =
  | { readonly kind: "update"; readonly node: InverseNode; readonly owner?: ScenePrimitiveSnapshot }
  | { readonly kind: "create"; readonly nodeId: string }
  | { readonly kind: "delete"; readonly nodes: readonly CapturedSubtreeNode[]; readonly primitive: PrimitiveState; readonly references?: SceneReferenceSnapshot }
  | { readonly kind: "primitive"; readonly objectId: string; readonly snapshot: ScenePrimitiveSnapshot }
  | { readonly kind: "camera"; readonly camera: SceneCameraSnapshot };

interface CapturedSubtreeNode {
  readonly id: string;
  readonly parent: string | null;
  readonly siblingIndex: number;
  readonly transform: SceneLocalTransform;
  readonly hidden: boolean;
  readonly localBounds: SceneTransformNodeSnapshot<string>["localBounds"];
}

/** SDK owns prepare/CAS/cancel orchestration; graph remains the sole state owner. */
export class SceneGraphTransactionDriver implements SceneCommandTransactionDriver {
  private readonly gateway: SceneMutationGateway;
  private inverse: InverseEntry[] = [];
  private appliedRevision: number | undefined;
  private appliedGeneration: number | undefined;
  private readonly baseGeneration: number;
  private flush: SceneTransformFlushResult<string> | undefined;

  constructor(private readonly graph: SceneTransformGraph<string>, private readonly options: {
    readonly sceneId: string; readonly transactionId: string; readonly baseRevision: number;
    readonly parser: SceneMutationCommandParser;
    /** 宿主几何/材质所有者;缺省时 create/delete-primitive 维持 fail-closed 拒绝。 */
    readonly primitiveOwner?: ScenePrimitiveOwnerPort;
    /** 宿主相机权威态(第三批);缺省时 camera.set/fly-to fail-closed 拒绝——graph 不含相机,相机属宿主状态。 */
    readonly cameraPort?: SceneCameraPort;
    /** 宿主作者引用容器(第三批第一子集);注入后删除 port 图元时清理 selectionSets/rootLayerOrder 引用,未消费域引用如实拒绝。 */
    readonly referenceCleanup?: SceneReferenceCleanupPort;
  }) {
    this.gateway = new SceneMutationGateway(graph, { sceneId: options.sceneId, parser: options.parser });
    this.baseGeneration = graph.generation;
  }

  readRevision(): number { return this.graph.revision; }
  /** Publish only after SDK outcome, so cancellation never exposes an intermediate flush. */
  get finalFlush(): SceneTransformFlushResult<string> | undefined { return this.flush; }

  apply(commands: readonly SceneCommand[]) {
    if (this.graph.revision !== this.options.baseRevision) throw new Error("Scene revision changed before graph apply.");
    if (this.graph.generation !== this.baseGeneration) throw new Error("Scene generation changed before graph apply.");
    if (this.appliedRevision !== undefined) throw new Error("Graph transaction driver is single-use.");
    const inverse: InverseEntry[] = [];
    // graph 原子事务失败时,已完成的 port 变更按逆序补偿,保证注册表与图一致。
    const portUndo: Array<() => void> = [];
    try {
      this.graph.transaction(() => {
        for (const input of commands) {
          const command = this.options.parser.parse(input) as SceneCommand;
          if (command.type === "object.create-primitive" || command.type === "object.delete-primitive") {
            if (command.target.sceneId !== this.options.sceneId || command.target.kind !== "object") {
              throw new Error("Primitive command scope is invalid.");
            }
            if (!this.options.primitiveOwner) throw new Error("Native graph primitive ownership is not hosted in this driver; command refused (fail-closed).");
            if (command.type === "object.create-primitive") this.applyCreate(command, inverse, portUndo);
            else this.applyDelete(command, inverse, portUndo);
          } else if (command.type === "object.set-parent") {
            if (command.target.sceneId !== this.options.sceneId || command.target.kind !== "object") throw new Error("Parent command scope is invalid.");
            const owner = this.captureOwnerSnapshot(command.target.objectId);
            inverse.push({ kind: "update", node: this.capture(command.target.objectId), ...(owner ? { owner } : {}) });
            this.graph.reparent(command.target.objectId, command.parentId, { keepWorldTransform: command.keepWorldTransform ?? false });
            // parent 走 graph 层级:图元归属子树随父移动,资源不变;keepWorld 重算的本地 TRS 投影回 port。
            if (owner) this.projectPrimitiveFromGraph(command.target.objectId);
          } else if (command.type === "material.set") {
            if (command.target.sceneId !== this.options.sceneId || command.target.kind !== "object") throw new Error("Material command scope is invalid.");
            const owner = this.options.primitiveOwner;
            if (!owner) throw new Error("Native graph material ownership is not hosted in this driver; command refused (fail-closed).");
            if (!owner.has(command.target.objectId)) {
              throw new Error(`Material command target ${command.target.objectId} is not owned by the scene primitive owner; command refused (fail-closed).`);
            }
            inverse.push({ kind: "primitive", objectId: command.target.objectId, snapshot: this.ownerSnapshot(command.target.objectId) });
            owner.syncMaterial(command.target.objectId, command.patch);
          } else if (command.type === "camera.set" || command.type === "camera.fly-to") {
            // 相机属宿主状态(graph 是对象层级):经 cameraPort 消费,缺省 fail-closed 拒绝。
            assertCameraSceneScope(command, this.options.sceneId);
            const camera = this.options.cameraPort;
            if (!camera) throw new Error("Native graph camera ownership is not hosted in this driver; command refused (fail-closed).");
            inverse.push({ kind: "camera", camera: camera.snapshot() });
            if (command.type === "camera.set") {
              camera.setCamera({ position: command.position, target: command.target,
                ...(command.near === undefined ? {} : { near: command.near }),
                ...(command.far === undefined ? {} : { far: command.far }),
                ...(command.fov === undefined ? {} : { fov: command.fov }) });
            } else {
              // 时长缓动属宿主相机 Tween 播放层;事务驱动只消费即时终点态,不伪装已执行
              // (与 ViewerSceneCommandPort.flyCamera 的 durationMs>0 unsupported 同语义)。
              if (command.durationMs > 0) {
                throw new Error("camera.fly-to with a duration requires the host camera tween playback layer; this driver only consumes immediate end states (fail-closed).");
              }
              camera.flyTo(this.resolveFlyIntent(command.target));
            }
          } else {
            const prepared = this.gateway.prepare(this.options.transactionId, [command]);
            if (prepared.status === "rejected") throw new Error(prepared.issues.map(issue => issue.message).join("; "));
            if (prepared.status === "noop") continue;
            for (const mutation of prepared.changeset.commands) {
              const owner = this.captureOwnerSnapshot(mutation.nodeId);
              inverse.push({ kind: "update", node: this.capture(mutation.nodeId), ...(owner ? { owner } : {}) });
              this.graph.update(mutation.nodeId, mutation.kind === "transform"
                ? { localTransform: mutation.transform } : { hidden: mutation.hidden });
              // 触碰解锁:graph 权威 TRS/hidden 同步投影进 PrimitiveState,图元保持可编译。
              if (owner) this.projectPrimitiveFromGraph(mutation.nodeId);
            }
          }
        }
      });
    } catch (error) {
      for (const undo of [...portUndo].reverse()) undo();
      throw error;
    }
    this.inverse = inverse;
    this.flush = this.graph.flush();
    this.appliedRevision = this.graph.revision;
    this.appliedGeneration = this.graph.generation;
    return { revision: this.graph.revision, results: commands.map((command, index) => ({ index, id: command.id, type: command.type, success: true })) };
  }

  rollback(): number {
    // A rejected graph transaction already restored itself. No inverse is needed.
    if (this.appliedRevision === undefined || this.inverse.length === 0) return this.graph.revision;
    if (this.graph.revision !== this.appliedRevision || this.graph.generation !== this.appliedGeneration) throw new Error("Refusing rollback over newer scene state.");
    this.graph.transaction(() => {
      for (const entry of [...this.inverse].reverse()) {
        if (entry.kind === "update") {
          const snapshot = entry.node;
          this.graph.reparent(snapshot.nodeId, snapshot.parent, { siblingIndex: snapshot.siblingIndex });
          this.graph.update(snapshot.nodeId, { localTransform: snapshot.transform, hidden: snapshot.hidden });
          if (entry.owner) this.options.primitiveOwner!.applyPrimitiveState(entry.node.nodeId, entry.owner);
        } else if (entry.kind === "create") {
          this.options.primitiveOwner!.deletePrimitive(entry.nodeId);
          this.graph.removeSubtree(entry.nodeId);
        } else if (entry.kind === "delete") {
          this.options.primitiveOwner!.restorePrimitive(entry.primitive);
          for (const node of entry.nodes) this.restoreNode(node);
          if (entry.references) this.options.referenceCleanup!.restoreReferences(entry.references);
        } else if (entry.kind === "camera") {
          this.options.cameraPort!.restore(entry.camera);
        } else {
          this.options.primitiveOwner!.applyPrimitiveState(entry.objectId, entry.snapshot);
        }
      }
    });
    this.inverse = [];
    this.flush = this.graph.flush();
    this.appliedRevision = this.graph.revision;
    this.appliedGeneration = this.graph.generation;
    return this.graph.revision;
  }

  private applyCreate(
    command: Extract<SceneCommand, { type: "object.create-primitive" }>,
    inverse: InverseEntry[], portUndo: Array<() => void>,
  ): void {
    const owner = this.options.primitiveOwner!;
    const objectId = command.target.objectId;
    if (this.graph.has(objectId)) throw new Error(`Scene node ${objectId} already exists.`);
    if (owner.has(objectId)) throw new Error(`Primitive ${objectId} already exists.`);
    const primitive = primitiveStateFromCommand(command);
    owner.createPrimitive(primitive);
    portUndo.push(() => owner.deletePrimitive(objectId));
    const bounds = owner.localBounds(command.kind);
    if (!bounds) throw new Error(`Primitive kind ${command.kind} has no compiled geometry; creation refused.`);
    this.graph.create({ id: objectId, localTransform: identityTrs(), localBounds: bounds });
    inverse.push({ kind: "create", nodeId: objectId });
  }

  private applyDelete(
    command: Extract<SceneCommand, { type: "object.delete-primitive" }>,
    inverse: InverseEntry[], portUndo: Array<() => void>,
  ): void {
    const owner = this.options.primitiveOwner!;
    const objectId = command.target.objectId;
    const primitive = owner.get(objectId);
    if (!primitive) throw new Error(`Primitive ${objectId} is not owned by the scene primitive owner.`);
    if (primitive.locked) throw new Error(`Primitive ${objectId} is locked; deletion requires an unlocked primitive.`);
    const subtree = this.captureSubtree(objectId);
    // 引用清理(第三批第一子集):先捕获 before 态再清理;未消费域引用在 prune 内先检查后
    // 清理如实拒绝——拒绝发生在任何变更之前,无需补偿。清理成功后登记逆序恢复。
    let references: SceneReferenceSnapshot | undefined;
    const cleanup = this.options.referenceCleanup;
    if (cleanup) {
      references = cleanup.snapshotReferences();
      cleanup.pruneDeletedObjectReferences(objectId);
      portUndo.push(() => cleanup.restoreReferences(references!));
    }
    owner.deletePrimitive(objectId);
    portUndo.push(() => owner.restorePrimitive(primitive));
    this.graph.removeSubtree(objectId);
    inverse.push({ kind: "delete", nodes: subtree, primitive: structuredClone(primitive), ...(references ? { references } : {}) });
  }

  private captureSubtree(rootId: string): CapturedSubtreeNode[] {
    const captured: CapturedSubtreeNode[] = [];
    const visit = (id: string): void => {
      const node = this.graph.getNode(id);
      if (!node) throw new Error(`Scene node ${id} does not exist.`);
      const siblings = node.parent === null ? this.graph.rootIds : this.graph.getNode(node.parent)!.children;
      captured.push({ id: node.id, parent: node.parent, siblingIndex: siblings.indexOf(node.id),
        transform: node.localTransform, hidden: node.hidden, localBounds: node.localBounds });
      for (const child of node.children) visit(child);
    };
    visit(rootId);
    return captured;
  }

  private restoreNode(node: CapturedSubtreeNode): void {
    // create input 无 hidden 字段;隐藏节点按原 capture 顺序 create 后以 update 恢复。
    this.graph.create({ id: node.id, parent: node.parent, siblingIndex: node.siblingIndex,
      localTransform: node.transform, localBounds: node.localBounds });
    if (node.hidden) this.graph.update(node.id, { hidden: true });
  }

  /** port 拥有节点的 before 态捕获(非 port 节点返回 undefined)。 */
  private captureOwnerSnapshot(nodeId: string): ScenePrimitiveSnapshot | undefined {
    const owner = this.options.primitiveOwner;
    if (!owner || !owner.has(nodeId)) return undefined;
    return this.ownerSnapshot(nodeId);
  }

  private ownerSnapshot(nodeId: string): ScenePrimitiveSnapshot {
    const owner = this.options.primitiveOwner!;
    return { primitive: structuredClone(owner.get(nodeId)!), diverged: owner.isNodeDiverged(nodeId) };
  }

  /** 触碰解锁投影:graph 节点权威本地变换(TRS 或 keepWorld 矩阵)/hidden 镜像进 PrimitiveState。 */
  private projectPrimitiveFromGraph(nodeId: string): void {
    const owner = this.options.primitiveOwner!;
    const node = this.graph.getNode(nodeId);
    if (!node) throw new Error(`Scene node ${nodeId} does not exist.`);
    owner.syncTransform(nodeId, modelTransformFromSceneLocal(node.localTransform));
    owner.syncVisibility(nodeId, !node.hidden);
  }

  /**
   * camera.fly-to 目标解析(driver 持有 graph,负责把命令目标变成几何事实):
   * {position}→look-at;object 引用→focus-object(graph 世界矩阵平移,节点不存在则拒绝);
   * scene 引用→fit-scene(全节点世界包围盒并集中心,无 bounds 节点回退世界矩阵平移)。
   */
  private resolveFlyIntent(rawTarget: Extract<SceneCommand, { type: "camera.fly-to" }>["target"]): SceneCameraFlyIntent {
    if ("position" in rawTarget) return { kind: "look-at", target: rawTarget.position };
    if (rawTarget.kind === "scene") {
      let min: [number, number, number] = [Infinity, Infinity, Infinity];
      let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      let count = 0;
      const visit = (id: string): void => {
        const node = this.graph.getNode(id);
        if (!node) return;
        const bounds = node.worldBounds;
        if (bounds) {
          count += 1;
          for (let axis = 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis]!, bounds.min[axis]!);
            max[axis] = Math.max(max[axis]!, bounds.max[axis]!);
          }
        }
        for (const child of node.children) visit(child);
      };
      for (const root of this.graph.rootIds) visit(root);
      if (count === 0) throw new Error("camera.fly-to fit-scene target requires at least one node with bounds; command refused (fail-closed).");
      return { kind: "fit-scene", worldCenter: [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2] };
    }
    const node = this.graph.getNode(rawTarget.objectId);
    if (!node) throw new Error(`camera.fly-to object target ${rawTarget.objectId} does not exist in this graph.`);
    return { kind: "focus-object", objectId: rawTarget.objectId,
      worldPosition: [node.worldMatrix[12]!, node.worldMatrix[13]!, node.worldMatrix[14]!] };
  }

  private capture(nodeId: string): InverseNode {
    const node = this.graph.getNode(nodeId);
    if (!node) throw new Error(`Scene node ${nodeId} does not exist.`);
    const siblings = node.parent === null ? this.graph.rootIds : this.graph.getNode(node.parent)!.children;
    return { nodeId, parent: node.parent, siblingIndex: siblings.indexOf(nodeId), transform: node.localTransform, hidden: node.hidden };
  }
}

function identityTrs(): SceneLocalTransform {
  return { kind: "trs", translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}
