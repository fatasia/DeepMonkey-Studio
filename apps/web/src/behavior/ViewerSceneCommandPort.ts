import type { DataEventAction, JsonValue } from "@bim-studio/contracts";
import type { SceneCommand, SceneMaterialCommandPatch, SceneObjectRef } from "@bim-studio/scene-sdk";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { inspectSceneCustomShader } from "../delivery/sceneCustomShader";
import { SCENE_COMMAND_APPLIED, type SceneCommandPort, type SceneCommandPortOutcome } from "./SceneCommandExecutor";
import { assembleCameraFlyTween } from "../commands/SceneCameraFlyTween";
import { startCameraFlyTweenPlayback, type CameraFlyTweenPlaybackOptions } from "../commands/SceneCameraFlyTweenPlayback";
import type { SceneCameraPort, SceneCameraPose } from "../commands/SceneCameraPort";

const unsupported = (message: string): SceneCommandPortOutcome => ({ status: "unsupported", message });
const DATA_ACTIONS = new Set<DataEventAction>(["color", "visibility", "position", "label", "opacity", "focus", "animation", "effects", "material", "alarm"]);

export class ViewerSceneCommandPort implements SceneCommandPort {
  constructor(private readonly viewer: ViewerEngine, private readonly componentUpdater?: (componentId: string, patch: Record<string, unknown>) => void,
    private readonly primitiveRemover?: (objectId: string) => void,
    private readonly tweenSchedule?: Pick<CameraFlyTweenPlaybackOptions, "requestFrame" | "cancelFrame" | "now">) {}

  deletePrimitive(target: Extract<SceneObjectRef, { kind: "object" }>): SceneCommandPortOutcome {
    const model = this.viewer.listModels().find(candidate => candidate.id === target.objectId);
    if (!model || model.kind !== "primitive") return unsupported("删除命令仅支持已存在的作者图元。");
    if (this.viewer.isModelLocked(target.objectId)) return unsupported(`对象 ${target.objectId} 已锁定。`);
    if (!this.primitiveRemover) return unsupported("当前宿主尚未连接作者图元删除。");
    this.primitiveRemover(target.objectId);
    if (this.hasModel(target.objectId)) return unsupported("作者控制器未删除目标图元。");
    return SCENE_COMMAND_APPLIED;
  }

  createPrimitive(command: Extract<SceneCommand, { type: "object.create-primitive" }>): SceneCommandPortOutcome {
    if (this.hasModel(command.target.objectId)) return unsupported(`对象 ${command.target.objectId} 已存在。`);
    this.viewer.createPrimitive(command.target.objectId, command.name, command.kind, command.color);
    return SCENE_COMMAND_APPLIED;
  }

  setObjectVisibility(target: SceneObjectRef, visible: boolean): SceneCommandPortOutcome {
    if (target.kind === "scene") {
      for (const model of this.viewer.listModels()) this.viewer.setVisible(model.id, visible);
      return SCENE_COMMAND_APPLIED;
    }
    if (!this.hasModel(target.objectId)) return unsupported(`对象 ${target.objectId} 不存在。`);
    if (target.kind === "mesh") {
      this.viewer.setLayerVisible(target.objectId, target.meshId, visible);
      return SCENE_COMMAND_APPLIED;
    }
    this.viewer.setVisible(target.objectId, visible);
    return SCENE_COMMAND_APPLIED;
  }

  setObjectTransform(target: SceneObjectRef, transform: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }): SceneCommandPortOutcome {
    if (target.kind !== "object") return unsupported("场景与 Mesh 级变换尚未开放，请选择模型对象。");
    const applied = this.viewer.setModelTransform(target.objectId, {
      ...(transform.position ? { position: transform.position } : {}),
      ...(transform.rotation ? { rotation: transform.rotation } : {}),
      ...(transform.scale ? { scale: transform.scale } : {})
    });
    return applied ? SCENE_COMMAND_APPLIED : unsupported(`对象 ${target.objectId} 不存在。`);
  }

  setObjectMaterial(target: SceneObjectRef, patch: SceneMaterialCommandPatch): SceneCommandPortOutcome {
    if (target.kind !== "object") return unsupported("当前脚本材质接口只修改模型对象；构件材质请在属性面板中编辑。");
    if (!this.hasModel(target.objectId)) return unsupported(`对象 ${target.objectId} 不存在。`);
    if (this.viewer.isModelLocked(target.objectId)) return unsupported(`对象 ${target.objectId} 已锁定。`);
    if (patch.customShader !== undefined) {
      const compiled = inspectSceneCustomShader(patch.customShader.source);
      if (!compiled.success) return unsupported(`材质源码编译失败：${compiled.diagnostics.join("；")}`);
    }
    this.viewer.setModelMaterial(target.objectId, patch);
    return SCENE_COMMAND_APPLIED;
  }

  setSelection(targets: readonly SceneObjectRef[]): SceneCommandPortOutcome {
    if (targets.length === 0) {
      this.viewer.select(undefined);
      return SCENE_COMMAND_APPLIED;
    }
    if (targets.length > 1) return unsupported("当前视口尚未开放多对象 Scene SDK 选择。可先使用编辑器选择集。");
    const target = targets[0]!;
    if (target.kind === "scene") return unsupported("场景根节点不能作为对象选区。");
    if (!this.hasModel(target.objectId)) return unsupported(`对象 ${target.objectId} 不存在。`);
    if (target.kind === "mesh") this.viewer.selectLayer(target.objectId, target.meshId);
    else this.viewer.select(target.objectId);
    return SCENE_COMMAND_APPLIED;
  }

  /** H-C7-P4 B5:场景级灯光 patch(合并到当前 GlobalLightingState,宿主 setter 全量消费)。 */
  setLighting(_sceneId: string, patch: { enabled?: boolean; intensity?: number; shadowsEnabled?: boolean; globalIlluminationEnabled?: boolean; globalIlluminationIntensity?: number }): SceneCommandPortOutcome {
    const current = this.viewer.getGlobalLighting();
    this.viewer.setGlobalLighting({
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.intensity !== undefined ? { intensity: patch.intensity } : {}),
      ...(patch.shadowsEnabled !== undefined ? { shadowsEnabled: patch.shadowsEnabled } : {}),
      ...(patch.globalIlluminationEnabled !== undefined ? { globalIlluminationEnabled: patch.globalIlluminationEnabled } : {}),
      ...(patch.globalIlluminationIntensity !== undefined ? { globalIlluminationIntensity: patch.globalIlluminationIntensity } : {})
    });
    return SCENE_COMMAND_APPLIED;
  }

  /** H-C7-P4 B5:场景级环境 patch(weather/backgroundColor/environmentIntensity 合并)。 */
  setEnvironment(_sceneId: string, patch: { backgroundColor?: string; weather?: "sunny" | "cloudy" | "rain" | "snow" | "fog" | "storm"; environmentIntensity?: number }): SceneCommandPortOutcome {
    const contract = this.viewer.getSceneEnvironment();
    this.viewer.setSceneEnvironment({
      ...contract,
      ...(patch.backgroundColor !== undefined ? { backgroundColor: patch.backgroundColor } : {}),
      ...(patch.environmentIntensity !== undefined ? { environmentIntensity: patch.environmentIntensity } : {})
    });
    if (patch.weather !== undefined) this.viewer.setWeather(patch.weather);
    return SCENE_COMMAND_APPLIED;
  }

  /**
   * H-C7-P3:场景级状态机锚迁移——删除流 fail-closed 拒绝被初始/活动锚引用的对象时,
   * 宿主据此先把锚迁到存活状态再删。校验目标状态存在于引擎权威态 stateMachine.states,
   * 未知状态 fail-closed 人话拒绝;写经 setSceneAnimation 全量回写(引擎规范化口径)。
   */
  setAnimationAnchor(_sceneId: string, anchor: { initialStateId?: string; activeStateId?: string }): SceneCommandPortOutcome {
    const current = this.viewer.getSceneAnimation();
    const machine = current.stateMachine;
    if (!machine) return unsupported("当前场景没有动画状态机，无法迁移状态机锚。");
    const stateIds = new Set(machine.states.map(state => state.id));
    if (anchor.initialStateId !== undefined && !stateIds.has(anchor.initialStateId)) {
      return unsupported(`状态机初始状态锚 ${anchor.initialStateId} 不是已声明状态(现有:${[...stateIds].join("、") || "无"})，迁移拒绝（fail-closed）。`);
    }
    if (anchor.activeStateId !== undefined && !stateIds.has(anchor.activeStateId)) {
      return unsupported(`状态机活动状态锚 ${anchor.activeStateId} 不是已声明状态(现有:${[...stateIds].join("、") || "无"})，迁移拒绝（fail-closed）。`);
    }
    this.viewer.setSceneAnimation({
      ...current,
      stateMachine: {
        ...machine,
        ...(anchor.initialStateId !== undefined ? { initialStateId: anchor.initialStateId } : {}),
        ...(anchor.activeStateId !== undefined ? { activeStateId: anchor.activeStateId } : {}),
      },
    });
    return SCENE_COMMAND_APPLIED;
  }

  setCamera(_sceneId: string, camera: { position: [number, number, number]; target: [number, number, number]; near?: number; far?: number; fov?: number }): SceneCommandPortOutcome {
    this.viewer.setCameraPose(camera);
    return SCENE_COMMAND_APPLIED;
  }

  flyCamera(_sceneId: string, target: SceneObjectRef | { position: [number, number, number] }, durationMs: number): SceneCommandPortOutcome {
    // H-C7-P3:时长飞行走宿主 Tween 播放层——终点解析复用既有即时取景逼近
    // (look-at/focus-object/fit-scene 同一策略),再从真实起点起飞;同 port 新起飞
    // 自动取消旧飞行。仍不向事务驱动发 durationMs>0 的 fly-to。
    if (durationMs > 30_000) return unsupported("相机飞行时长上限 30 秒。");
    if (durationMs > 0) {
      const start = this.viewer.getCameraState();
      const immediate = this.consumeFlyTargetImmediate(target);
      if (immediate.status !== "applied") return immediate;
      const end = this.viewer.getCameraState();
      const toPose = (state: typeof start): SceneCameraPose => ({
        position: [state.position.x, state.position.y, state.position.z],
        target: [state.target.x, state.target.y, state.target.z]
      });
      const from = toPose(start), to = toPose(end);
      const tween = assembleCameraFlyTween(from, to, { durationMs });
      this.viewer.setCameraPose({ position: [...from.position], target: [...from.target] });
      startCameraFlyTweenPlayback({
        port: this.cameraTweenPort(), tween,
        ...(this.tweenSchedule?.requestFrame ? { requestFrame: this.tweenSchedule.requestFrame } : {}),
        ...(this.tweenSchedule?.cancelFrame ? { cancelFrame: this.tweenSchedule.cancelFrame } : {}),
        ...(this.tweenSchedule?.now ? { now: this.tweenSchedule.now } : {})
      });
      return SCENE_COMMAND_APPLIED;
    }
    return this.consumeFlyTargetImmediate(target);
  }

  /** fly-to 的即时终点态消费(时长=0 路径与时长飞行的终点解析共用同一取景策略)。 */
  private consumeFlyTargetImmediate(target: SceneObjectRef | { position: [number, number, number] }): SceneCommandPortOutcome {
    if ("position" in target) {
      const current = this.viewer.getCameraState();
      this.viewer.setCameraPose({
        position: [current.position.x, current.position.y, current.position.z],
        target: target.position
      });
      return SCENE_COMMAND_APPLIED;
    }
    if (target.kind === "scene") {
      this.viewer.fitAll();
      return SCENE_COMMAND_APPLIED;
    }
    return this.viewer.focusModel(target.objectId, target.kind === "mesh" ? target.meshId : undefined)
      ? SCENE_COMMAND_APPLIED
      : unsupported(`相机目标 ${target.objectId} 不存在。`);
  }

  /** viewer 相机态到 SceneCameraPort 的最小适配(播放层只消费 setCamera)。 */
  private cameraTweenPort(): SceneCameraPort {
    return {
      setCamera: pose => this.viewer.setCameraPose({ position: [...pose.position], target: [...pose.target],
        ...(pose.near === undefined ? {} : { near: pose.near }), ...(pose.far === undefined ? {} : { far: pose.far }),
        ...(pose.fov === undefined ? {} : { fov: pose.fov }) }),
      flyTo: () => { throw new Error("相机 Tween 播放层不消费 fly-to。"); },
      snapshot: () => { const state = this.viewer.getCameraState();
        return { pose: { position: [state.position.x, state.position.y, state.position.z], target: [state.target.x, state.target.y, state.target.z] }, lastIntent: null }; },
      restore: () => {}
    };
  }

  controlAnimation(target: SceneObjectRef, control: { action: "play" | "pause" | "stop" | "seek"; clipId?: string; time?: number }): SceneCommandPortOutcome {
    if (target.kind !== "object") return unsupported("当前仅支持模型对象动画控制。");
    if (!this.viewer.hasAnimation(target.objectId)) return unsupported(`对象 ${target.objectId} 没有可用动画。`);
    const applied = this.viewer.controlAnimation(target.objectId, control);
    return applied ? SCENE_COMMAND_APPLIED : unsupported("动画 Clip 不存在，或定位时间无效。");
  }

  applyData(target: SceneObjectRef, data: { values: Record<string, JsonValue>; timestamp: string }): SceneCommandPortOutcome {
    if (target.kind === "scene") return unsupported("数据命令需要对象或 Mesh 目标。");
    if (!this.hasModel(target.objectId)) return unsupported(`对象 ${target.objectId} 不存在。`);
    let applied = 0;
    for (const [key, value] of Object.entries(data.values)) {
      if (!DATA_ACTIONS.has(key as DataEventAction)) continue;
      if (this.viewer.applySceneDataMessage({
        source: "behavior",
        key,
        value,
        timestamp: data.timestamp,
        target: { modelId: target.objectId, ...(target.kind === "mesh" ? { layerId: target.meshId } : {}) },
        action: key as DataEventAction
      })) applied += 1;
    }
    return applied > 0 ? SCENE_COMMAND_APPLIED : unsupported("数据字段没有匹配可执行的场景动作。");
  }

  updateComponent(componentId: string, patch: Record<string, JsonValue>): SceneCommandPortOutcome {
    if (!this.componentUpdater) return unsupported("当前宿主未连接二维组件更新端口。");
    this.componentUpdater(componentId, patch);
    return SCENE_COMMAND_APPLIED;
  }

  private hasModel(modelId: string): boolean {
    return this.viewer.listModels().some((model) => model.id === modelId);
  }
}
