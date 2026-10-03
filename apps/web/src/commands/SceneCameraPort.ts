import type { SceneCommand } from "@bim-studio/scene-sdk";

/**
 * H-C7-P3 第三批 宿主相机 port:camera.set / camera.fly-to 的宿主消费接缝。
 *
 * graph 是对象层级,不含相机——相机 pose 属宿主状态。driver 保持宿主无关:
 * options.cameraPort 缺省时相机命令 fail-closed 拒绝(不扩张),注入后经本 port 消费。
 *
 * 语义与浏览器命令端口(ViewerSceneCommandPort.flyCamera)对齐:
 * - durationMs > 0 的相机飞行在 driver 侧如实拒绝(时长缓动属宿主相机 Tween 播放层,
 *   事务驱动只消费即时终点态,不伪装已执行);
 * - look-at 类消费只改观察目标点,宿主位置保持自身逼近策略。
 */

/** camera.set 的场景级 pose(position/target 必填,near/far/fov 可选)。 */
export interface SceneCameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly near?: number;
  readonly far?: number;
  readonly fov?: number;
}

/**
 * camera.fly-to 的已解析消费意图。driver 持有 graph,负责把命令目标解析成几何事实:
 * - {position} → look-at(目标点即命令值);
 * - object 引用 → focus-object(objectId + graph 世界矩阵平移,节点不存在则拒绝);
 * - scene 引用 → fit-scene(graph 全节点世界包围盒并集中心)。
 */
export type SceneCameraFlyIntent =
  | { readonly kind: "look-at"; readonly target: readonly [number, number, number] }
  | { readonly kind: "focus-object"; readonly objectId: string; readonly worldPosition: readonly [number, number, number] }
  | { readonly kind: "fit-scene"; readonly worldCenter: readonly [number, number, number] };

/** 逆算子捕获的相机 before 态;pose=null 表示宿主尚无相机权威态。 */
export interface SceneCameraSnapshot {
  readonly pose: SceneCameraPose | null;
  readonly lastIntent: SceneCameraFlyIntent | null;
}

export interface SceneCameraPort {
  /** camera.set 消费:整体写入场景级相机 pose(宿主权威态)。 */
  setCamera(pose: SceneCameraPose): void;
  /** camera.fly-to 消费(仅即时终点态;durationMs>0 已在 driver 侧拒绝,不会到达)。 */
  flyTo(intent: SceneCameraFlyIntent): void;
  /** 逆算子捕获:当前相机权威态(深拷贝)。 */
  snapshot(): SceneCameraSnapshot;
  /** 回滚恢复到捕获态。 */
  restore(snapshot: SceneCameraSnapshot): void;
}

export interface SceneCameraOwnerOptions {
  readonly sceneId: string;
}

/** 参考实现:宿主侧相机权威态注册表(与 ScenePrimitiveOwner 同族的最小 sink)。 */
export class SceneCameraOwner implements SceneCameraPort {
  private pose: SceneCameraPose | null = null;
  private lastIntent: SceneCameraFlyIntent | null = null;

  constructor(private readonly options: SceneCameraOwnerOptions) {
    if (!options || typeof options !== "object" || !options.sceneId?.trim()) {
      throw new TypeError("Scene camera owner requires a sceneId.");
    }
  }

  get sceneId(): string { return this.options.sceneId; }

  setCamera(pose: SceneCameraPose): void {
    assertFiniteTriple(pose.position, "camera.position");
    assertFiniteTriple(pose.target, "camera.target");
    this.pose = clonePose(pose);
  }

  flyTo(intent: SceneCameraFlyIntent): void {
    if (intent.kind === "focus-object" && !intent.objectId.trim()) {
      throw new Error("camera.fly-to focus-object requires an objectId.");
    }
    const target = flyTargetOf(intent);
    assertFiniteTriple(target, "fly-to target");
    this.lastIntent = cloneIntent(intent);
    // 即时终点态:观察目标点落到解析结果;位置保持(与浏览器 position 分支同语义)。
    this.pose = this.pose
      ? { ...this.pose, target: [...target] as [number, number, number] }
      : { position: [0, 0, 0], target: [...target] as [number, number, number] };
  }

  snapshot(): SceneCameraSnapshot {
    return { pose: this.pose ? clonePose(this.pose) : null, lastIntent: this.lastIntent ? cloneIntent(this.lastIntent) : null };
  }

  restore(snapshot: SceneCameraSnapshot): void {
    this.pose = snapshot.pose ? clonePose(snapshot.pose) : null;
    this.lastIntent = snapshot.lastIntent ? cloneIntent(snapshot.lastIntent) : null;
  }
}

function flyTargetOf(intent: SceneCameraFlyIntent): readonly [number, number, number] {
  if (intent.kind === "look-at") return intent.target;
  if (intent.kind === "focus-object") return intent.worldPosition;
  return intent.worldCenter;
}

function clonePose(pose: SceneCameraPose): SceneCameraPose {
  return {
    position: [...pose.position] as [number, number, number],
    target: [...pose.target] as [number, number, number],
    ...(pose.near === undefined ? {} : { near: pose.near }),
    ...(pose.far === undefined ? {} : { far: pose.far }),
    ...(pose.fov === undefined ? {} : { fov: pose.fov }),
  };
}

function cloneIntent(intent: SceneCameraFlyIntent): SceneCameraFlyIntent {
  if (intent.kind === "look-at") return { kind: "look-at", target: [...intent.target] as [number, number, number] };
  if (intent.kind === "focus-object") {
    return { kind: "focus-object", objectId: intent.objectId, worldPosition: [...intent.worldPosition] as [number, number, number] };
  }
  return { kind: "fit-scene", worldCenter: [...intent.worldCenter] as [number, number, number] };
}

function assertFiniteTriple(values: readonly number[] | undefined, label: string): void {
  if (!values || values.length !== 3 || !values.every(Number.isFinite)) {
    throw new Error(`Camera ${label} must be a finite [x,y,z] triple.`);
  }
}

/** camera 命令的 sceneId 守卫(driver 共用)。 */
export function assertCameraSceneScope(command: Extract<SceneCommand, { type: "camera.set" | "camera.fly-to" }>, sceneId: string): void {
  if (command.sceneId !== sceneId) throw new Error(`Camera command targets scene ${command.sceneId}; this driver owns scene ${sceneId}.`);
}
