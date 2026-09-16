import { SceneTransformGraphError, type SceneLocalTransform, type SceneTransformChange,
  type SceneTransformFlushResult, type SceneTransformNodeId } from "./types.js";
import type { SceneTransformGraph } from "./SceneTransformGraph.js";

/** DE26/B01 · 场景变化集:authoring(Three 侧)与 Deep 运行时共用的唯一权威变更通道。
 *
 * 所有权合同:SceneTransformGraph 是世界变换/可见性的**唯一权威**;作者快照投影进图,
 * 运行时与 GPU 缓存只消费 `flush()` 结果(按 revision+generation 键控),不得持有第二份
 * 权威状态。变化集是纯数据(可 JSON 序列化),同一变化集应用到任意宿主得到逐位一致的
 * 权威状态;迟到 revision 的命令整体拒绝且不触碰图;撤销是同一条通道的逆变化集,
 * 不产生第二份权威状态。 */

export const SCENE_CHANGESET_SCHEMA_VERSION = 1 as const;

export type SceneChangesetCommand =
  | { readonly kind: "transform"; readonly nodeId: string; readonly expectedRevision: number; readonly transform: SceneLocalTransform }
  | { readonly kind: "hidden"; readonly nodeId: string; readonly expectedRevision: number; readonly hidden: boolean };

export interface SceneChangeset {
  readonly schemaVersion: typeof SCENE_CHANGESET_SCHEMA_VERSION;
  readonly id: string;
  /** 提交时要求的图全局 revision;不匹配视为迟到命令整体拒绝。 */
  readonly baseRevision: number;
  readonly commands: readonly SceneChangesetCommand[];
}

export interface SceneChangesetRejection {
  readonly index: number;
  readonly nodeId: string;
  readonly reason: "stale-revision" | "missing-node" | "base-revision" | "invalid-transform";
  readonly message: string;
}

export type SceneChangesetOutcome =
  | { readonly status: "applied"; readonly revision: number; readonly flush: SceneTransformFlushResult<SceneTransformNodeId> }
  | { readonly status: "rejected"; readonly rejections: readonly SceneChangesetRejection[] };

const CHANGESET_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** 构造并校验变化集;重复 nodeId、非法形状在此 fail-closed。 */
export function createSceneChangeset(id: string, baseRevision: number, commands: readonly SceneChangesetCommand[]): SceneChangeset {
  if (!CHANGESET_ID.test(id)) throw new SceneTransformGraphError("invalid-id", `Scene changeset id is invalid: ${id}`);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new SceneTransformGraphError("invalid-index", "Scene changeset baseRevision must be a non-negative integer.");
  }
  if (!Array.isArray(commands) || !commands.length) throw new SceneTransformGraphError("invalid-options", "Scene changeset requires at least one command.");
  const seen = new Set<string>();
  for (const [index, command] of commands.entries()) {
    if (!command || typeof command !== "object") throw new SceneTransformGraphError("invalid-options", `Command ${index} is not an object.`);
    if (command.kind !== "transform" && command.kind !== "hidden") throw new SceneTransformGraphError("invalid-options", `Command ${index} has an unknown kind.`);
    if (!CHANGESET_ID.test(command.nodeId)) throw new SceneTransformGraphError("invalid-id", `Command ${index} nodeId is invalid.`);
    if (seen.has(command.nodeId)) throw new SceneTransformGraphError("invalid-options", `Command ${index} targets ${command.nodeId} twice; one changeset must carry one command per node.`);
    seen.add(command.nodeId);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new SceneTransformGraphError("invalid-index", `Command ${index} expectedRevision must be a non-negative integer.`);
    }
    if (command.kind === "transform" && !isFiniteTransform(command.transform)) {
      throw new SceneTransformGraphError("invalid-transform", `Command ${index} transform contains non-finite values.`);
    }
  }
  return { schemaVersion: SCENE_CHANGESET_SCHEMA_VERSION, id, baseRevision, commands: [...commands] };
}

function isFiniteTransform(transform: unknown): boolean {
  if (!transform || typeof transform !== "object") return false;
  if ((transform as { kind?: unknown }).kind === "trs") {
    const { translation, rotation, scale } = transform as { translation: unknown; rotation: unknown; scale: unknown };
    return [translation, rotation, scale].every(vector => Array.isArray(vector) && vector.every(value => Number.isFinite(value)));
  }
  const { matrix } = transform as { matrix?: unknown };
  return Array.isArray(matrix) && matrix.every(value => Number.isFinite(value));
}

interface NodeRead {
  readonly exists: boolean;
  readonly lastChangedRevision: number;
  readonly localTransform: SceneLocalTransform | null;
  readonly hidden: boolean | null;
}

function readNode(graph: SceneTransformGraph<SceneTransformNodeId>, nodeId: string): NodeRead {
  const snapshot = graph.getNode(nodeId as SceneTransformNodeId);
  if (!snapshot) return { exists: false, lastChangedRevision: -1, localTransform: null, hidden: null };
  return { exists: true, lastChangedRevision: snapshot.lastChangedRevision, localTransform: snapshot.localTransform, hidden: snapshot.hidden };
}

function rejectionsFor(graph: SceneTransformGraph<SceneTransformNodeId>, changeset: SceneChangeset): SceneChangesetRejection[] {
  const rejections: SceneChangesetRejection[] = [];
  if (changeset.baseRevision !== graph.revision) {
    return [{ index: -1, nodeId: "", reason: "base-revision",
      message: `Changeset expects revision ${changeset.baseRevision}, graph is at ${graph.revision}.` }];
  }
  for (const [index, command] of changeset.commands.entries()) {
    const node = readNode(graph, command.nodeId);
    if (!node.exists) {
      rejections.push({ index, nodeId: command.nodeId, reason: "missing-node", message: `Scene node ${command.nodeId} does not exist.` });
      continue;
    }
    if (node.lastChangedRevision !== command.expectedRevision) {
      rejections.push({ index, nodeId: command.nodeId, reason: "stale-revision",
        message: `Node ${command.nodeId} changed at revision ${node.lastChangedRevision}; command expects ${command.expectedRevision}.` });
    }
  }
  return rejections;
}

/** 两阶段应用:全量校验通过后在一个图事务内原子应用并 flush;任何拒绝都不触碰图。 */
export function applySceneChangeset(graph: SceneTransformGraph<SceneTransformNodeId>, changeset: SceneChangeset): SceneChangesetOutcome {
  const rejections = rejectionsFor(graph, changeset);
  if (rejections.length) return { status: "rejected", rejections };
  try {
    graph.transaction(() => {
      for (const command of changeset.commands) {
        if (command.kind === "transform") graph.update(command.nodeId as SceneTransformNodeId, { localTransform: command.transform });
        else graph.update(command.nodeId as SceneTransformNodeId, { hidden: command.hidden });
      }
    });
    // 图禁止事务内 flush;事务提交后整帧推进,保持单一权威 revision。
    const flush = graph.flush();
    return { status: "applied", revision: flush.revision, flush };
  } catch (error) {
    // 事务已回滚;把图的校验错误映射为逐命令拒绝(通常是 transform 细节校验失败)。
    const message = error instanceof Error ? error.message : String(error);
    const mapped: SceneChangesetRejection[] = changeset.commands.map((command, index) => ({
      index, nodeId: command.nodeId, reason: "invalid-transform", message }));
    return { status: "rejected", rejections: mapped };
  }
}

/** 应用前捕获逆变化集;撤销与正向走同一 CAS 通道,迟到撤销同样整体拒绝。 */
export function captureSceneChangesetInverse(graph: SceneTransformGraph<SceneTransformNodeId>, changeset: SceneChangeset): SceneChangeset {
  const inverse: SceneChangesetCommand[] = [];
  for (const command of [...changeset.commands].reverse()) {
    const node = readNode(graph, command.nodeId);
    if (!node.exists) throw new SceneTransformGraphError("missing-node", `Cannot invert changeset for missing node ${command.nodeId}.`);
    if (command.kind === "transform") inverse.push({ kind: "transform", nodeId: command.nodeId,
      expectedRevision: node.lastChangedRevision, transform: node.localTransform! });
    else inverse.push({ kind: "hidden", nodeId: command.nodeId, expectedRevision: node.lastChangedRevision, hidden: node.hidden! });
  }
  return createSceneChangeset(`${changeset.id}.undo`, graph.revision, inverse);
}

/** 供证据链使用的纯数据视图:同一变化集在任意宿主重放得到同一权威状态。 */
export type SceneChangesetChange = SceneTransformChange<SceneTransformNodeId>;
