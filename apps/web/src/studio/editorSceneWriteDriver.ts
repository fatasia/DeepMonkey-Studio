import type { GlobalLightingState, ModelTransform, SceneAnimationState, SceneCapability, SceneEnvironmentState, SceneLayerState, SceneMaterialState, ScenePermission, WeatherMode } from "@bim-studio/contracts";
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
import { primitiveDeletionReferenceError, type EditorPrimitiveDeleteAuthoring } from "./editorPrimitiveDeleteAuthoring";
import type { SceneEditTransaction } from "../hooks/useSceneHistoryState";

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
  authoring?: EditorPrimitiveDeleteAuthoring | undefined;
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
  | { kind: "remove-created"; model: { id: string; visible: boolean } }
  | { kind: "visibility"; modelId: string; visible: boolean }
  | { kind: "mesh-visibility"; modelId: string; meshId: string; visible: boolean }
  | { kind: "transform"; objectId: string; transform: ModelTransform }
  | { kind: "material"; objectId: string; material: SceneMaterialState }
  | { kind: "selection"; selection: { modelId: string; meshId?: string } | undefined }
  | { kind: "camera"; pose: CameraPose }
  | { kind: "lighting"; state: GlobalLightingState }
  | { kind: "environment"; state: SceneEnvironmentState; weather?: WeatherMode }
  | { kind: "animation-anchor"; initialStateId: string; activeStateId: string };

/** driver 需要的只读状态读取面；ViewerEngine 结构化满足，测试可注入伪实现。 */
export interface EditorSceneStateReader {
  listModels(): readonly { id: string; visible: boolean }[];
  getSelected(): { id: string } | undefined;
  getSelectedLayerId(): string | undefined;
  getModelTransform(id: string): ModelTransform | undefined;
  getModelMaterialState(id: string): SceneMaterialState | undefined;
  getLayerStates(modelId: string): SceneLayerState[];
  getCameraState(): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } };
  getGlobalLighting?(): GlobalLightingState;
  getSceneEnvironment?(): SceneEnvironmentState;
  getWeather?(): WeatherMode;
  /** H-C7-P3:状态机锚迁移的逆算子捕获面(引擎权威态只读出);缺省 fail-closed 拒绝该命令。 */
  getSceneAnimation?(): SceneAnimationState;
}

export class EditorSceneWriteDriver implements SceneCommandTransactionDriver {
  private inverseStack: InverseOperation[] = [];
  private deletion: SceneEditTransaction | undefined;
  private deletionRevision: number | undefined;
  private deletionMutated = false;
  private deletionIdentityConflict = false;
  private deletedObjectId: string | undefined;

  constructor(private readonly host: EditorSceneWriteDriverHost, private readonly reader: EditorSceneStateReader) {}

  readRevision(): number {
    return this.host.readRevision();
  }

  async apply(commands: readonly SceneCommand[]): Promise<SceneCommandTransactionApplyResult> {
    this.inverseStack = [];
    const deletion = commands.find(command => command.type === "object.delete-primitive");
    if (deletion) {
      // 混批删除:删除可与创建/变换/材质/可见性同事务;每事务最多一条删除,
      // 多删除的撤销序无合同,fail-closed。
      const deletionCount = commands.filter(command => command.type === "object.delete-primitive").length;
      if (deletionCount > 1) throw new Error("一个事务最多包含一条图元删除。");
      if (!this.host.authoring) throw new Error("当前作者未连接可恢复的图元删除。");
      const transaction = this.host.authoring.begin("删除作者图元");
      const before = transaction.before;
      const referenceError = before && primitiveDeletionReferenceError(before, deletion.target.objectId);
      if (!before || referenceError) { transaction.rollback(); throw new Error(referenceError ?? "作者快照未就绪，删除未执行。"); }
      this.deletion = transaction;
      this.deletedObjectId = deletion.target.objectId;
    }
    const stack = this.inverseStack;
    const reader = this.reader;
    const inner = this.host.port;
    const capturing: SceneCommandPort = {
      deletePrimitive: target => {
        if (!inner.deletePrimitive) return { status: "unsupported", message: "作者图元删除未连接。" };
        const before = reader.listModels().find(model => model.id === target.objectId);
        try { return inner.deletePrimitive(target); }
        finally {
          const after = reader.listModels().find(model => model.id === target.objectId);
          this.deletionMutated = !!before && after !== before;
          this.deletionIdentityConflict = !!after && after !== before;
        }
      },
      createPrimitive: command => {
        if (!inner.createPrimitive) return { status: "unsupported", message: "当前宿主尚未连接图元创建。" };
        if (reader.listModels().some(model => model.id === command.target.objectId)) return { status: "unsupported", message: `对象 ${command.target.objectId} 已存在。` };
        captureSelection(reader, stack);
        try { return inner.createPrimitive(command); }
        finally {
          const model = reader.listModels().find(candidate => candidate.id === command.target.objectId);
          if (model) stack.push({ kind: "remove-created", model });
        }
      },
      setObjectVisibility: (target, visible) => { captureVisibility(reader, stack, target); return inner.setObjectVisibility(target, visible); },
      setObjectTransform: (target, transform) => { if (target.kind === "object") captureTransform(reader, stack, target.objectId); return inner.setObjectTransform(target, transform); },
      setObjectMaterial: (target, patch) => { if (target.kind === "object") captureMaterial(reader, stack, target.objectId); return inner.setObjectMaterial(target, patch); },
      setSelection: targets => { captureSelection(reader, stack); return inner.setSelection(targets); },
      setCamera: (sceneId, camera) => { captureCamera(reader, stack); return inner.setCamera(sceneId, camera); },
      flyCamera: (sceneId, target, durationMs) => { captureCamera(reader, stack); return inner.flyCamera(sceneId, target, durationMs); },
      setLighting: (sceneId, patch) => {
        if (!inner.setLighting) return { status: "unsupported", message: "当前宿主尚未连接场景灯光状态。" };
        if (!reader.getGlobalLighting) return { status: "unsupported", message: "当前宿主无法捕获可恢复的灯光状态，未执行修改。" };
        stack.push({ kind: "lighting", state: structuredClone(reader.getGlobalLighting()) });
        return inner.setLighting(sceneId, patch);
      },
      setEnvironment: (sceneId, patch) => {
        if (!inner.setEnvironment) return { status: "unsupported", message: "当前宿主尚未连接场景环境状态。" };
        if (!reader.getSceneEnvironment || (patch.weather !== undefined && !reader.getWeather)) {
          return { status: "unsupported", message: "当前宿主无法捕获可恢复的环境状态，未执行修改。" };
        }
        stack.push({ kind: "environment", state: structuredClone(reader.getSceneEnvironment()),
          ...(patch.weather !== undefined ? { weather: reader.getWeather!() } : {}) });
        return inner.setEnvironment(sceneId, patch);
      },
      setAnimationAnchor: (sceneId, anchor) => {
        if (!inner.setAnimationAnchor) return { status: "unsupported", message: "当前宿主尚未连接状态机锚迁移。" };
        if (!reader.getSceneAnimation) return { status: "unsupported", message: "当前宿主无法捕获可恢复的状态机锚，未执行修改。" };
        // 只捕获旧锚(绝对值逆算子,幂等重放);场景无状态机时不捕获——port 会 fail-closed 拒绝写入。
        const machine = reader.getSceneAnimation().stateMachine;
        if (machine) stack.push({ kind: "animation-anchor", initialStateId: machine.initialStateId, activeStateId: machine.activeStateId });
        return inner.setAnimationAnchor(sceneId, anchor);
      },
      controlAnimation: (target, control) => inner.controlAnimation(target, control),
      applyData: (target, data) => inner.applyData(target, data),
      updateComponent: (componentId, patch) => inner.updateComponent(componentId, patch),
    };
    const results = await new SceneCommandExecutor(this.host.sceneId, capturing).execute(commands);
    this.host.bumpRevision();
    if (this.deletion) this.deletionRevision = this.readRevision();
    return {
      revision: this.readRevision(),
      results: results.map(result => ({
        index: result.index, id: result.id, type: result.type, success: result.success,
        ...(result.success ? {} : { message: result.message }),
      })),
    };
  }

  /** 绝对值逆算子倒序重放；重复执行结果不变（幂等）。含删除的混批事务先重放
   * 非删除效果（含移除本事务创建的对象），再由作者快照恢复删除——快照
   * begin 于事务开始，覆盖两者。 */
  rollback(context: SceneCommandTransactionRollbackContext): number | Promise<number> {
    void context;
    if (this.deletion) {
      this.replayInverseOperations();
      return this.rollbackDeletion();
    }
    this.replayInverseOperations();
    this.host.bumpRevision();
    return this.readRevision();
  }

  private replayInverseOperations(): void {
    const viewer = this.host.viewer;
    for (const op of [...this.inverseStack].reverse()) {
      switch (op.kind) {
        case "remove-created": {
          const current = viewer.listModels().find(model => model.id === op.model.id);
          if (current && current !== op.model) throw new Error(`对象 ${op.model.id} 已被替换，不能回滚删除。`);
          if (current) viewer.removeModel(op.model.id);
          break;
        }
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
        case "lighting": viewer.setGlobalLighting(op.state); break;
        case "environment":
          viewer.setSceneEnvironment(op.state);
          if (op.weather !== undefined) viewer.setWeather(op.weather);
          break;
        case "animation-anchor": {
          const current = viewer.getSceneAnimation();
          // 状态机仍在时才回写旧锚(绝对值重放);机已不存在则无锚可恢复,保持一致跳过。
          if (current.stateMachine) {
            viewer.setSceneAnimation({ ...current, stateMachine: { ...current.stateMachine, initialStateId: op.initialStateId, activeStateId: op.activeStateId } });
          }
          break;
        }
      }
    }
    this.inverseStack = [];
  }

  commitAuthoringHistory(): void { this.deletion?.commit(); this.deletion = undefined; }

  private async rollbackDeletion(): Promise<number> {
    const transaction = this.deletion!;
    this.deletion = undefined;
    const before = transaction.rollback();
    const replacement = this.deletionMutated && this.reader.listModels().some(model => model.id === this.deletedObjectId);
    if (replacement || this.deletionIdentityConflict || (this.deletionRevision !== undefined && this.readRevision() !== this.deletionRevision)) throw new Error("作者版本或对象身份已改变，不能用删除前快照覆盖新编辑。");
    if (before && this.deletionMutated) await this.host.authoring!.restore(before);
    this.host.bumpRevision();
    return this.readRevision();
  }
}

/**
 * H-C7-P4 B5：场景级命令（lighting.set / environment.set）的 draft 文档回写拆分。
 * 命令执行由宿主端口推引擎；引擎不回写 React draft，保存链路（makeSceneSnapshot
 * 消费 React state）将丢失命令效果。宿主在事务 committed 后按此合并 draft state。
 * weather 是独立 React state，不进 SceneEnvironmentState 合并面。
 */
export interface SceneMetadataDraftPatch {
  lightingPatch?: { enabled?: boolean; intensity?: number; shadowsEnabled?: boolean; globalIlluminationEnabled?: boolean; globalIlluminationIntensity?: number };
  environmentPatch?: { backgroundColor?: string; environmentIntensity?: number };
  weather?: "sunny" | "cloudy" | "rain" | "snow" | "fog" | "storm";
  /** H-C7-P3:状态机锚迁移的 draft 合并面(仅携带命令给出的锚,缺省项不动 draft)。 */
  animationAnchorPatch?: { initialStateId?: string; activeStateId?: string };
}

export function sceneMetadataDraftPatch(commands: readonly unknown[]): SceneMetadataDraftPatch {
  const result: SceneMetadataDraftPatch = {};
  for (const raw of commands) {
    const command = raw as { type?: unknown; patch?: unknown; anchor?: unknown };
    if (!command || typeof command !== "object") continue;
    if (command.type === "animation.set-anchor") {
      if (!command.anchor || typeof command.anchor !== "object") continue;
      const { initialStateId, activeStateId } = command.anchor as Record<string, unknown>;
      if (typeof initialStateId === "string" && initialStateId.trim()) {
        result.animationAnchorPatch = { ...result.animationAnchorPatch, initialStateId };
      }
      if (typeof activeStateId === "string" && activeStateId.trim()) {
        result.animationAnchorPatch = { ...result.animationAnchorPatch, activeStateId };
      }
      continue;
    }
    if (!command.patch || typeof command.patch !== "object") continue;
    const patch = command.patch as Record<string, unknown>;
    if (command.type === "lighting.set") {
      const { enabled, intensity, shadowsEnabled, globalIlluminationEnabled, globalIlluminationIntensity } = patch;
      result.lightingPatch = {
        ...result.lightingPatch,
        ...(enabled === undefined ? {} : { enabled: Boolean(enabled) }),
        ...(typeof intensity === "number" ? { intensity } : {}),
        ...(shadowsEnabled === undefined ? {} : { shadowsEnabled: Boolean(shadowsEnabled) }),
        ...(globalIlluminationEnabled === undefined ? {} : { globalIlluminationEnabled: Boolean(globalIlluminationEnabled) }),
        ...(typeof globalIlluminationIntensity === "number" ? { globalIlluminationIntensity } : {}),
      };
    } else if (command.type === "environment.set") {
      const { weather, backgroundColor, environmentIntensity } = patch;
      if (backgroundColor !== undefined || environmentIntensity !== undefined) {
        result.environmentPatch = {
          ...result.environmentPatch,
          ...(backgroundColor === undefined ? {} : { backgroundColor: String(backgroundColor) }),
          ...(typeof environmentIntensity === "number" ? { environmentIntensity } : {}),
        };
      }
      if (typeof weather === "string" && ["sunny", "cloudy", "rain", "snow", "fog", "storm"].includes(weather)) {
        result.weather = weather as "sunny" | "cloudy" | "rain" | "snow" | "fog" | "storm";
      }
    }
  }
  return result;
}

/** 组装浏览器事务执行：准备失败（结构/权限/能力）原样回传；视口未就绪与场景不匹配 fail-closed。 */
export async function runEditorSceneTransaction(
  host: { sceneId: string; viewer: () => ViewerEngine | undefined; readRevision(): number; bumpRevision(): void; port?: SceneCommandPort; authoring?: EditorPrimitiveDeleteAuthoring | undefined },
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
    { sceneId: host.sceneId, viewer, port: host.port ?? new ViewerSceneCommandPort(viewer, undefined, host.authoring?.remove), readRevision: host.readRevision, bumpRevision: host.bumpRevision, authoring: host.authoring },
    viewer,
  );
  const outcome = await commitSceneCommandTransaction(preparation.plan, driver);
  switch (outcome.status) {
    case "committed": driver.commitAuthoringHistory(); return { status: "committed", receipt: outcome.receipt };
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
