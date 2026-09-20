import type { ModelTransform, SceneCapability, SceneLayerState, SceneMaterialState, ScenePermission } from "@bim-studio/contracts";
import {
  commitSceneCommandTransaction,
  prepareSceneCommandTransaction,
  type SceneCommand,
  type SceneCommandTransactionApplyResult,
  type SceneCommandTransactionDriver,
  type SceneCommandTransactionRollbackContext,
  type SceneObjectRef,
} from "@bim-studio/scene-sdk";
import { SceneCommandExecutor, type SceneCommandPort } from "../behavior/SceneCommandExecutor";
import { ViewerSceneCommandPort } from "../behavior/ViewerSceneCommandPort";
import type { ViewerEngine } from "../viewer/ViewerEngine";

/**
 * 浏览器 editor driver：SceneCommandTransaction 的唯一执行方。
 * apply 走既有 UI 命令端口（ViewerSceneCommandPort + SceneCommandExecutor），
 * 不绕过 UI 直改场景；每条命令执行前捕获可逆操作的逆算子，rollback 按倒序
 * 重放绝对值设置（天然幂等）。动画控制与数据推送是运行时效果、无可靠读取口，
 * 声明为不可逆并在结果信封外如实说明。
 */
export interface EditorSceneWriteDriverHost {
  sceneId: string;
  viewer: ViewerEngine;
  port: SceneCommandPort;
  readRevision(): number;
  bumpRevision(): void;
}

export interface EditorDriverTransactionRequest {
  requestId: string;
  transaction: {
    id: string;
    sceneId: string;
    baseRevision: number;
    module: { id: string; capabilities: readonly string[]; permissions: readonly string[] };
    commands: readonly unknown[];
  };
}

export interface EditorDriverTransactionResult {
  status: "committed" | "rolled-back" | "rejected" | "failed";
  receipt?: unknown;
  issue?: unknown;
  issues?: readonly unknown[];
}

type CameraPose = { position: [number, number, number]; target: [number, number, number] };

type InverseOperation =
  | { kind: "visibility"; modelId: string; visible: boolean }
  | { kind: "mesh-visibility"; modelId: string; meshId: string; visible: boolean }
  | { kind: "transform"; objectId: string; transform: ModelTransform }
  | { kind: "material"; objectId: string; material: SceneMaterialState }
  | { kind: "selection"; selection: { modelId: string; meshId?: string } | undefined }
  | { kind: "camera"; pose: CameraPose };

/** driver 需要的只读状态读取面；ViewerEngine 结构化满足，测试可注入伪实现。 */
export interface EditorSceneStateReader {
  listModels(): readonly { id: string; visible: boolean }[];
  getSelected(): { id: string } | undefined;
  getSelectedLayerId(): string | undefined;
  getModelTransform(id: string): ModelTransform | undefined;
  getModelMaterialState(id: string): SceneMaterialState | undefined;
  getLayerStates(modelId: string): SceneLayerState[];
  getCameraState(): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } };
}

export class EditorSceneWriteDriver implements SceneCommandTransactionDriver {
  private inverseStack: InverseOperation[] = [];

  constructor(private readonly host: EditorSceneWriteDriverHost, private readonly reader: EditorSceneStateReader) {}

  readRevision(): number {
    return this.host.readRevision();
  }

  async apply(commands: readonly SceneCommand[]): Promise<SceneCommandTransactionApplyResult> {
    this.inverseStack = [];
    const stack = this.inverseStack;
    const reader = this.reader;
    const inner = this.host.port;
    const capturing: SceneCommandPort = {
      setObjectVisibility: (target, visible) => { captureVisibility(reader, stack, target); return inner.setObjectVisibility(target, visible); },
      setObjectTransform: (target, transform) => { if (target.kind === "object") captureTransform(reader, stack, target.objectId); return inner.setObjectTransform(target, transform); },
      setObjectMaterial: (target, patch) => { if (target.kind === "object") captureMaterial(reader, stack, target.objectId); return inner.setObjectMaterial(target, patch); },
      setSelection: targets => { captureSelection(reader, stack); return inner.setSelection(targets); },
      setCamera: (sceneId, camera) => { captureCamera(reader, stack); return inner.setCamera(sceneId, camera); },
      flyCamera: (sceneId, target, durationMs) => { captureCamera(reader, stack); return inner.flyCamera(sceneId, target, durationMs); },
      controlAnimation: (target, control) => inner.controlAnimation(target, control),
      applyData: (target, data) => inner.applyData(target, data),
      updateComponent: (componentId, patch) => inner.updateComponent(componentId, patch),
    };
    const results = await new SceneCommandExecutor(this.host.sceneId, capturing).execute(commands);
    this.host.bumpRevision();
    return {
      revision: this.readRevision(),
      results: results.map(result => ({
        index: result.index, id: result.id, type: result.type, success: result.success,
        ...(result.success ? {} : { message: result.message }),
      })),
    };
  }

  /** 绝对值逆算子倒序重放；重复执行结果不变（幂等）。 */
  rollback(context: SceneCommandTransactionRollbackContext): number {
    void context;
    const viewer = this.host.viewer;
    for (const op of [...this.inverseStack].reverse()) {
      switch (op.kind) {
        case "visibility": viewer.setVisible(op.modelId, op.visible); break;
        case "mesh-visibility": viewer.setLayerVisible(op.modelId, op.meshId, op.visible); break;
        case "transform": viewer.setModelTransform(op.objectId, toArrays(op.transform)); break;
        case "material": viewer.setModelMaterial(op.objectId, op.material); break;
        case "selection":
          if (!op.selection) viewer.select(undefined);
          else if (op.selection.meshId) viewer.selectLayer(op.selection.modelId, op.selection.meshId);
          else viewer.select(op.selection.modelId);
          break;
        case "camera": viewer.setCameraPose(op.pose); break;
      }
    }
    this.host.bumpRevision();
    return this.readRevision();
  }
}

/** 组装浏览器事务执行：准备失败（结构/权限/能力）原样回传；视口未就绪与场景不匹配 fail-closed。 */
export async function runEditorSceneTransaction(
  host: { sceneId: string; viewer: () => ViewerEngine | undefined; readRevision(): number; bumpRevision(): void; port?: SceneCommandPort },
  request: EditorDriverTransactionRequest,
): Promise<EditorDriverTransactionResult> {
  const transaction = request.transaction;
  if (transaction.sceneId !== host.sceneId) {
    return { status: "rejected", issue: { index: -1, reason: "scene-mismatch", message: `事务场景 ${transaction.sceneId} 与活跃场景 ${host.sceneId} 不一致` } };
  }
  const viewer = host.viewer();
  if (!viewer) return { status: "failed", issue: { index: -1, reason: "driver-error", message: "场景视口未就绪，无法执行写事务" } };
  const preparation = prepareSceneCommandTransaction({
    id: transaction.id,
    sceneId: transaction.sceneId,
    baseRevision: transaction.baseRevision,
    module: {
      id: transaction.module.id,
      capabilities: transaction.module.capabilities as readonly SceneCapability[],
      permissions: transaction.module.permissions as readonly ScenePermission[],
    },
    commands: transaction.commands,
  });
  if (preparation.status === "rejected") return { status: "rejected", issues: preparation.issues };
  const driver = new EditorSceneWriteDriver(
    { sceneId: host.sceneId, viewer, port: host.port ?? new ViewerSceneCommandPort(viewer), readRevision: host.readRevision, bumpRevision: host.bumpRevision },
    viewer,
  );
  const outcome = await commitSceneCommandTransaction(preparation.plan, driver);
  switch (outcome.status) {
    case "committed": return { status: "committed", receipt: outcome.receipt };
    case "rolled-back": return { status: "rolled-back", receipt: outcome.receipt, issue: outcome.issue };
    case "rejected": return { status: "rejected", issue: outcome.issue };
    case "failed": return { status: "failed", issue: outcome.issue };
  }
}

function captureVisibility(reader: EditorSceneStateReader, stack: InverseOperation[], target: SceneObjectRef): void {
  if (target.kind === "scene") {
    for (const model of reader.listModels()) stack.push({ kind: "visibility", modelId: model.id, visible: model.visible });
    return;
  }
  if (target.kind === "mesh") {
    const state = reader.getLayerStates(target.objectId).find(layer => layer.nodeId === target.meshId);
    if (state) stack.push({ kind: "mesh-visibility", modelId: target.objectId, meshId: target.meshId, visible: state.visible ?? true });
    return;
  }
  const model = reader.listModels().find(candidate => candidate.id === target.objectId);
  if (model) stack.push({ kind: "visibility", modelId: model.id, visible: model.visible });
}

function captureTransform(reader: EditorSceneStateReader, stack: InverseOperation[], objectId: string): void {
  const transform = reader.getModelTransform(objectId);
  if (transform) stack.push({ kind: "transform", objectId, transform });
}

function captureMaterial(reader: EditorSceneStateReader, stack: InverseOperation[], objectId: string): void {
  const material = reader.getModelMaterialState(objectId);
  if (material) stack.push({ kind: "material", objectId, material });
}

function captureSelection(reader: EditorSceneStateReader, stack: InverseOperation[]): void {
  const selected = reader.getSelected();
  const meshId = reader.getSelectedLayerId();
  stack.push({ kind: "selection", selection: selected ? { modelId: selected.id, ...(meshId ? { meshId } : {}) } : undefined });
}

function captureCamera(reader: EditorSceneStateReader, stack: InverseOperation[]): void {
  const state = reader.getCameraState();
  stack.push({ kind: "camera", pose: { position: [state.position.x, state.position.y, state.position.z], target: [state.target.x, state.target.y, state.target.z] } });
}

function toArrays(transform: ModelTransform): { position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] } {
  return {
    position: [transform.position.x, transform.position.y, transform.position.z],
    rotation: [transform.rotation.x, transform.rotation.y, transform.rotation.z],
    scale: [transform.scale.x, transform.scale.y, transform.scale.z],
  };
}
