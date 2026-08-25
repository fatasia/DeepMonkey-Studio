import type { DataEventAction, JsonValue } from "@bim-studio/contracts";
import type { SceneObjectRef } from "@bim-studio/scene-sdk";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { SCENE_COMMAND_APPLIED, type SceneCommandPort, type SceneCommandPortOutcome } from "./SceneCommandExecutor";

const unsupported = (message: string): SceneCommandPortOutcome => ({ status: "unsupported", message });
const DATA_ACTIONS = new Set<DataEventAction>(["color", "visibility", "position", "label", "opacity", "focus", "animation", "effects"]);

export class ViewerSceneCommandPort implements SceneCommandPort {
  constructor(private readonly viewer: ViewerEngine) {}

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

  setCamera(_sceneId: string, camera: { position: [number, number, number]; target: [number, number, number]; near?: number; far?: number; fov?: number }): SceneCommandPortOutcome {
    this.viewer.setCameraPose(camera);
    return SCENE_COMMAND_APPLIED;
  }

  flyCamera(_sceneId: string, target: SceneObjectRef | { position: [number, number, number] }, durationMs: number): SceneCommandPortOutcome {
    if (durationMs > 0) return unsupported("带时长的相机飞行将在相机 Tween 公开端口完成后开放；当前不会伪装为已执行。");
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

  controlAnimation(target: SceneObjectRef, control: { action: "play" | "pause" | "stop" | "seek"; clipId?: string; time?: number }): SceneCommandPortOutcome {
    if (target.kind !== "object") return unsupported("当前仅支持模型对象动画控制。");
    if (control.clipId || control.action === "seek" || control.action === "stop") return unsupported("动画 Clip 选择、停止与定位尚未开放到 Viewer 端口。");
    if (!this.viewer.hasAnimation(target.objectId)) return unsupported(`对象 ${target.objectId} 没有可用动画。`);
    this.viewer.setAnimationEnabled(target.objectId, control.action === "play");
    return SCENE_COMMAND_APPLIED;
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

  private hasModel(modelId: string): boolean {
    return this.viewer.listModels().some((model) => model.id === modelId);
  }
}
