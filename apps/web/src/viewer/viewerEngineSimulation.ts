import * as THREE from "three";
import type { SceneAnimationState, SceneCharacterControllerState, ScenePhysicsBodyState, ScenePhysicsState } from "@bim-studio/contracts";
import { normalizeAnimationFrameRate, normalizeSceneAnimationPlaybackRange } from "./timeline";
import { applyTransform } from "./sceneObjectUtils";
import { configureCharacterController, moveRapierCharacter } from "./rapierCharacterController";
import { normalizePhysicsGears, normalizePhysicsJoints } from "./rapierPhysicsJoint";
import { ViewerEngineSimulationDebug } from "./viewerEngineSimulationDebug";

function cloneCharacter(state: SceneCharacterControllerState): SceneCharacterControllerState {
  return {
    ...(state.offset === undefined ? {} : { offset: state.offset }),
    ...(state.maxSlopeClimbAngle === undefined ? {} : { maxSlopeClimbAngle: state.maxSlopeClimbAngle }),
    ...(state.minSlopeSlideAngle === undefined ? {} : { minSlopeSlideAngle: state.minSlopeSlideAngle }),
    ...(state.autostep === undefined ? {} : { autostep: { ...state.autostep } }),
    ...(state.snapToGround === undefined ? {} : { snapToGround: { ...state.snapToGround } }),
  };
}

/**
 * Simulation 职责层(source-size 拆分,2026-10-04:自单文件按仿真子域分文件,
 * 代码逐行同源,仅改可见性;语义零变化)。
 *
 * 职责边界(本文件):作者态物理状态接口(get/set PhysicsState/BodyState)、
 * 角色控制器运行期参数与位移、位姿重置、场景动画播放控制。
 * 子域分层(各文件公开/保护方法签名与拆分前逐字一致,宿主 API 不变):
 *   录制/回放与拆分字段 → viewerEngineSimulationRecording.ts;
 *   Rapier 世界/刚体/关节/齿轮/碰撞事件 → viewerEngineSimulationWorld.ts;
 *   播放与手动固定步进 → viewerEngineSimulationStep.ts;
 *   调试快照与三路调试图层接线 → viewerEngineSimulationDebug.ts。
 * 继承关系:ViewerEngineRig → Recording → World → Step → Debug → 本类。
 */
export abstract class ViewerEngineSimulation extends ViewerEngineSimulationDebug {
  getPhysicsState(): ScenePhysicsState {
      return structuredClone(this.physicsState);
    }
  setPhysicsState(state: ScenePhysicsState): void {
      const joints = normalizePhysicsJoints(state.joints);
      const gears = normalizePhysicsGears(state.gears, joints);
      this.physicsState = {
        enabled: state.enabled,
        playing: state.enabled && state.playing,
        gravity: { ...state.gravity },
        ...(joints.length ? { joints } : {}),
        ...(gears.length ? { gears } : {}),
      };
      this.physicsHost.configure(this.physicsState);
      if (state.enabled) void this.ensurePhysicsWorld().then(() => {
        if (this.physicsWorld) this.physicsWorld.gravity = { ...this.physicsState.gravity };
        this.rebuildPhysicsJoints();
      });
    }
  getPhysicsBodyState(id: string): ScenePhysicsBodyState {
      return structuredClone(this.physicsBodyStates.get(id) ?? { type: "none", mass: 1, friction: 0.7, restitution: 0.15 });
    }
  async setPhysicsBodyState(id: string, state: ScenePhysicsBodyState): Promise<void> {
      if (!["none", "fixed", "dynamic", "kinematic"].includes(state.type)) throw new Error("不支持的物理刚体类型");
      if (state.character !== undefined && state.type !== "kinematic") throw new Error("角色控制器要求 kinematic 刚体");
      if (state.initialLinearVelocity && (state.type !== "dynamic"
        || ![state.initialLinearVelocity.x, state.initialLinearVelocity.y, state.initialLinearVelocity.z]
          .every(value => Number.isFinite(value) && Math.abs(value) <= 1_000))) {
        throw new Error("初速度要求 dynamic 且各轴在 ±1000 m/s 内");
      }
      const normalized: ScenePhysicsBodyState = {
        type: state.type,
        mass: THREE.MathUtils.clamp(state.mass, 0.01, 100_000),
        friction: THREE.MathUtils.clamp(state.friction, 0, 2),
        restitution: THREE.MathUtils.clamp(state.restitution, 0, 1),
        ...(state.initialLinearVelocity ? { initialLinearVelocity: { ...state.initialLinearVelocity } } : {}),
        // 角色控制器只跟随 kinematic;切成别的类型时丢弃,避免留下无消费者的载荷。
        ...(state.type === "kinematic" && state.character ? { character: cloneCharacter(state.character) } : {}),
      };
      this.physicsBodyStates.set(id, normalized);
      if (normalized.type !== "dynamic") {
        const joints = (this.physicsState.joints ?? []).filter((joint) => joint.bodyId !== id && joint.connectedBodyId !== id);
        const { joints: _discarded, ...physics } = this.physicsState;
        this.physicsState = joints.length ? { ...physics, joints } : physics;
      }
      this.removePhysicsBody(id);
      if (normalized.type === "none" || !this.models.has(id)) return;
      await this.ensurePhysicsWorld();
      this.createPhysicsBody(id, normalized);
      this.rebuildPhysicsJoints();
    }
  /** 运行期更新某个 kinematic 刚体的角色控制器参数;非 kinematic 或无运行时返回 false。 */
  updateCharacterController(id: string, character: SceneCharacterControllerState | undefined): boolean {
      const runtime = this.physicsBodies.get(id);
      const world = this.physicsWorld;
      if (!runtime?.character || !world) return false;
      configureCharacterController(runtime.character.controller, character);
      const state = this.physicsBodyStates.get(id);
      if (state) {
        const { character: _previous, ...bodyState } = state;
        this.physicsBodyStates.set(id, { ...bodyState, ...(character ? { character: cloneCharacter(character) } : {}) });
      }
      return true;
    }
  /** 计算并排队 Web 角色位移;Native 没有对应消费入口,保持降级边界。 */
  moveCharacter(id: string, delta: { x: number; y: number; z: number }): { movement: { x: number; y: number; z: number }; grounded: boolean } | undefined {
      const runtime = this.physicsBodies.get(id);
      if (!runtime?.character) return;
      return moveRapierCharacter(runtime.character, runtime.body, delta);
    }
  resetPhysics(): void {
      for (const [id, runtime] of this.physicsBodies) {
        const object = this.models.get(id)?.object;
        if (!object) continue;
        applyTransform(object, runtime.initialTransform);
        object.updateWorldMatrix(true, true);
        const position = object.getWorldPosition(new THREE.Vector3());
        const rotation = object.getWorldQuaternion(new THREE.Quaternion());
        runtime.body.setTranslation(position, true);
        runtime.body.setRotation(rotation, true);
        runtime.body.setLinvel(this.physicsBodyStates.get(id)?.initialLinearVelocity ?? { x: 0, y: 0, z: 0 }, true);
        runtime.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      this.physicsHost.resetClock();
    }
  getSceneAnimation(): SceneAnimationState {
      return structuredClone(this.sceneAnimation);
    }
  setSceneAnimation(animation: SceneAnimationState): void {
      this.sceneAnimation = {
        duration: Math.max(animation.duration, 0.1),
        loop: animation.loop,
        ...(animation.autoplay !== undefined ? { autoplay: animation.autoplay } : {}),
        ...(animation.stateMachine !== undefined ? { stateMachine: structuredClone(animation.stateMachine) } : {}),
        pingPong: animation.pingPong ?? false,
        playbackSpeed: THREE.MathUtils.clamp(animation.playbackSpeed ?? 1, 0.1, 4),
        ...(animation.playbackRange !== undefined ? { playbackRange: animation.playbackRange } : {}),
        frameRate: normalizeAnimationFrameRate(animation.frameRate),
        snapToFrames: animation.snapToFrames ?? false,
        cameraInterpolation: animation.cameraInterpolation ?? "smooth",
        modelInterpolation: animation.modelInterpolation ?? "smooth",
        showCameraPath: animation.showCameraPath ?? true,
        camera: [...animation.camera].sort((a, b) => a.time - b.time),
        models: [...animation.models].sort((a, b) => a.time - b.time)
      };
      // 播放头同步收敛进新的播放区间,避免缩小区间后残留越界时间。
      const range = normalizeSceneAnimationPlaybackRange(this.sceneAnimation.playbackRange, this.sceneAnimation.duration);
      this.sceneAnimationTime = THREE.MathUtils.clamp(this.sceneAnimationTime, range.inPoint, range.outPoint);
      this.updateCameraPathHelper();
      this.onAnimationChange?.(this.sceneAnimationTime, this.sceneAnimationPlaying);
    }
  seekSceneAnimation(time: number): void {
      const range = normalizeSceneAnimationPlaybackRange(this.sceneAnimation.playbackRange, this.sceneAnimation.duration);
      this.sceneAnimationTime = THREE.MathUtils.clamp(time, range.inPoint, range.outPoint);
      this.applySceneAnimationFrame(this.sceneAnimationTime);
      this.onAnimationChange?.(this.sceneAnimationTime, this.sceneAnimationPlaying);
    }
  playSceneAnimation(): void {
      if (this.sceneAnimation.camera.length === 0 && this.sceneAnimation.models.length === 0) return;
      const range = normalizeSceneAnimationPlaybackRange(this.sceneAnimation.playbackRange, this.sceneAnimation.duration);
      if (this.sceneAnimationDirection > 0 && this.sceneAnimationTime >= range.outPoint) {
        // 正向播放到出点后重新播放:回到入点起步。
        this.sceneAnimationTime = range.inPoint;
      } else if (this.sceneAnimationDirection < 0 && this.sceneAnimationTime <= range.inPoint) {
        // 倒放到入点后重新播放:从出点反向起步。
        this.sceneAnimationTime = range.outPoint;
      }
      const wasPlaying = this.sceneAnimationPlaying;
      this.sceneAnimationPlaying = true;
      this.orbit.enabled = false;
      this.updateTransformAccess();
      this.onAnimationChange?.(this.sceneAnimationTime, true);
      if (!wasPlaying) {
        for (const modelId of new Set(this.sceneAnimation.models.map((frame) => frame.modelId))) {
          queueMicrotask(() => this.dispatchObjectLifecycle("animationStart", modelId));
        }
      }
    }
  pauseSceneAnimation(): void {
      const wasPlaying = this.sceneAnimationPlaying;
      this.sceneAnimationPlaying = false;
      this.orbit.enabled = this.viewportOrbitIntent && this.navigationMode !== "firstPerson";
      this.updateTransformAccess();
      this.onAnimationChange?.(this.sceneAnimationTime, false);
      if (wasPlaying) {
        for (const modelId of new Set(this.sceneAnimation.models.map((frame) => frame.modelId))) {
          queueMicrotask(() => this.dispatchObjectLifecycle("animationEnd", modelId));
        }
      }
    }
  isSceneAnimationPlaying(): boolean {
      return this.sceneAnimationPlaying;
    }
  setSceneAnimationDirection(direction: 1 | -1): void {
      // 只切换方向不改播放状态:播放中立即掉头,暂停时由下一次 play 决定起步边界。
      this.sceneAnimationDirection = direction >= 0 ? 1 : -1;
    }
}
