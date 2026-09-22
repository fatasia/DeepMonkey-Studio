import * as THREE from "three";
import type { SceneAnimationState, SceneCharacterControllerState, ScenePhysicsBodyState, ScenePhysicsState } from "@bim-studio/contracts";
import { normalizeAnimationFrameRate, normalizeSceneAnimationPlaybackRange } from "./timeline";
import { applyTransform, objectTransform } from "./sceneObjectUtils";
import { ViewerEngineRig } from "./viewerEngineRig";
import { mountRapierJoint, normalizePhysicsJoints, removeMountedRapierJoint } from "./rapierPhysicsJoint";
import { configureCharacterController, moveRapierCharacter, mountRapierCharacterController, removeMountedRapierCharacter } from "./rapierCharacterController";
import { resolvePhysicsCollisionDispatches, type PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";
import { collectPhysicsCuboidDebugEntries } from "./rapierPhysicsDebugView";

function cloneCharacter(state: SceneCharacterControllerState): SceneCharacterControllerState {
  return {
    ...(state.offset === undefined ? {} : { offset: state.offset }),
    ...(state.maxSlopeClimbAngle === undefined ? {} : { maxSlopeClimbAngle: state.maxSlopeClimbAngle }),
    ...(state.minSlopeSlideAngle === undefined ? {} : { minSlopeSlideAngle: state.minSlopeSlideAngle }),
    ...(state.autostep === undefined ? {} : { autostep: { ...state.autostep } }),
    ...(state.snapToGround === undefined ? {} : { snapToGround: { ...state.snapToGround } }),
  };
}

/** Simulation 职责层。 */
export abstract class ViewerEngineSimulation extends ViewerEngineRig {
  getPhysicsState(): ScenePhysicsState {
      return structuredClone(this.physicsState);
    }
  setPhysicsState(state: ScenePhysicsState): void {
      const joints = normalizePhysicsJoints(state.joints);
      this.physicsState = {
        enabled: state.enabled,
        playing: state.enabled && state.playing,
        gravity: { ...state.gravity },
        ...(joints.length ? { joints } : {}),
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
      const normalized: ScenePhysicsBodyState = {
        type: state.type,
        mass: THREE.MathUtils.clamp(state.mass, 0.01, 100_000),
        friction: THREE.MathUtils.clamp(state.friction, 0, 2),
        restitution: THREE.MathUtils.clamp(state.restitution, 0, 1),
        // 角色控制器只跟随 kinematic；切成别的类型时丢弃，避免留下无消费者的载荷。
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
  /** 运行期更新某个 kinematic 刚体的角色控制器参数；非 kinematic 或无运行时返回 false。 */
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
  /** 计算并排队 Web 角色位移；Native 没有对应消费入口，保持降级边界。 */
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
        runtime.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        runtime.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      this.physicsHost.resetClock();
    }
  protected async ensurePhysicsWorld(): Promise<void> {
      if (this.physicsWorld) return;
      if (this.physicsInit) return this.physicsInit;
      this.physicsInit = (async () => {
        const module = await import("@dimforge/rapier3d-compat");
        const rapier = module.default;
        // The compat build embeds its WASM but currently calls wasm-bindgen's legacy
        // initializer signature. Hide only that known upstream deprecation warning.
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => {
          if (args[0] !== "using deprecated parameters for the initialization function; pass a single object instead") originalWarn(...args);
        };
        try {
          await rapier.init();
        } finally {
          console.warn = originalWarn;
        }
        if (this.rendererDisposalStarted) return;
        const world = new rapier.World({ ...this.physicsState.gravity });
        // B3-c：autoDrain 必须关——host.advance 的固定步进追赶循环里一步会跑多次
        // world.step，autoDrain=true 会把中间步的碰撞事件在下一个 step 前静默清掉。
        const eventQueue = new rapier.EventQueue(false);
        const attached = this.physicsHost.attach({
          setGravity: (gravity) => { world.gravity = { ...gravity }; },
          step: (timestep) => { world.timestep = timestep; world.step(eventQueue); },
          dispose: () => { eventQueue.free(); world.free(); },
        });
        if (!attached) { eventQueue.free(); world.free(); return; }
        this.rapier = rapier;
        this.physicsWorld = world;
        this.physicsEventQueue = eventQueue;
        const groundBody = world.createRigidBody(rapier.RigidBodyDesc.fixed());
        this.physicsGroundBody = groundBody;
        const ground = rapier.ColliderDesc.cuboid(5_000, 0.05, 5_000).setTranslation(0, -0.05, 0).setFriction(0.9);
        const groundCollider = world.createCollider(ground, groundBody);
        // 地面不是场景对象，只登记为 null 归属：碰撞事件里作为对端来源，自身不派发。
        this.physicsColliderOwners.set(groundCollider.handle, null);
        for (const [id, state] of this.physicsBodyStates) if (state.type !== "none" && !this.physicsBodies.has(id)) this.createPhysicsBody(id, state);
        this.rebuildPhysicsJoints();
      })().finally(() => { this.physicsInit = undefined; });
      return this.physicsInit;
    }
  protected createPhysicsBody(id: string, state: ScenePhysicsBodyState): void {
      const object = this.models.get(id)?.object;
      const world = this.physicsWorld;
      const rapier = this.rapier;
      if (!object || !world || !rapier || state.type === "none") return;
      object.updateWorldMatrix(true, true);
      const worldBox = new THREE.Box3().setFromObject(object);
      if (worldBox.isEmpty()) return;
      const inverse = object.matrixWorld.clone().invert();
      const localBox = worldBox.clone().applyMatrix4(inverse);
      const localCenter = localBox.getCenter(new THREE.Vector3());
      const localSize = localBox.getSize(new THREE.Vector3());
      const worldPosition = object.getWorldPosition(new THREE.Vector3());
      const worldRotation = object.getWorldQuaternion(new THREE.Quaternion());
      const worldScale = object.getWorldScale(new THREE.Vector3());
      const descriptor = state.type === "dynamic" ? rapier.RigidBodyDesc.dynamic()
        : state.type === "kinematic" ? rapier.RigidBodyDesc.kinematicPositionBased()
        : rapier.RigidBodyDesc.fixed();
      descriptor.setTranslation(worldPosition.x, worldPosition.y, worldPosition.z).setRotation(worldRotation);
      if (state.type === "dynamic") descriptor.setCcdEnabled(true).setLinearDamping(0.08).setAngularDamping(0.12);
      const body = world.createRigidBody(descriptor);
      const half = localSize.multiply(worldScale).multiplyScalar(0.5);
      const offset = localCenter.multiply(worldScale);
      const collider = rapier.ColliderDesc.cuboid(
        Math.max(Math.abs(half.x), 0.01),
        Math.max(Math.abs(half.y), 0.01),
        Math.max(Math.abs(half.z), 0.01)
      ).setTranslation(offset.x, offset.y, offset.z).setFriction(state.friction).setRestitution(state.restitution)
        // B3-c：没有该标志 Rapier 不生成碰撞事件；body 侧启用后与地面/其它 body 的接触都会入队。
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
      if (state.type === "dynamic") collider.setMass(state.mass);
      const colliderHandle = world.createCollider(collider, body);
      this.physicsColliderOwners.set(colliderHandle.handle, id);
      // 角色控制器只挂在 kinematic 刚体上；它靠宿主调用 setNextKinematicTranslation 移动。
      const character = state.type === "kinematic"
        ? mountRapierCharacterController(world, colliderHandle, state.character)
        : undefined;
      this.physicsBodies.set(id, { body, colliderHandle: colliderHandle.handle, initialTransform: objectTransform(object), ...(character ? { character } : {}) });
    }
  protected removePhysicsBody(id: string): void {
      this.removePhysicsJointsForBody(id);
      const runtime = this.physicsBodies.get(id);
      if (runtime?.character && this.physicsWorld) removeMountedRapierCharacter(this.physicsWorld, runtime.character);
      if (runtime && this.physicsWorld) this.physicsWorld.removeRigidBody(runtime.body);
      // 先注销句柄再删 body：同一帧内 drain 到的移除残留事件会被解析成“对端不可解析”。
      if (runtime) this.physicsColliderOwners.delete(runtime.colliderHandle);
      this.physicsBodies.delete(id);
    }
  protected rebuildPhysicsBody(id: string): void {
      const state = this.physicsBodyStates.get(id);
      if (!state || state.type === "none" || !this.physicsWorld) return;
      this.removePhysicsBody(id);
      this.createPhysicsBody(id, state);
      this.rebuildPhysicsJoints();
    }
  protected rebuildPhysicsJoints(): void {
      const world = this.physicsWorld, rapier = this.rapier, ground = this.physicsGroundBody;
      if (!world || !rapier || !ground) return;
      for (const joint of this.physicsJoints.values()) removeMountedRapierJoint(world, joint);
      this.physicsJoints.clear();
      for (const state of this.physicsState.joints ?? []) {
        const body = this.physicsBodies.get(state.bodyId)?.body;
        const connectedBody = state.connectedBodyId ? this.physicsBodies.get(state.connectedBodyId)?.body : ground;
        if (!body || !connectedBody) continue;
        const runtime = mountRapierJoint(rapier, world, connectedBody, body, state);
        this.physicsJoints.set(state.id, runtime);
      }
    }
  protected removePhysicsJointsForBody(bodyId: string): void {
      const world = this.physicsWorld;
      if (!world) return;
      const states = new Map((this.physicsState.joints ?? []).map((joint) => [joint.id, joint]));
      for (const [id, joint] of this.physicsJoints) {
        const state = states.get(id);
        if (state?.bodyId !== bodyId && state?.connectedBodyId !== bodyId) continue;
        removeMountedRapierJoint(world, joint);
        this.physicsJoints.delete(id);
      }
    }
  protected updatePhysics(delta: number): void {
      const world = this.physicsWorld;
      if (!world || !this.physicsState.enabled || !this.physicsState.playing) return;
      this.physicsHost.advance(delta);
      // 追赶循环内的多步事件已在队列里累积，统一在这里 drain 并派发给交互脚本。
      this.dispatchPhysicsCollisionEvents();
      for (const [id, runtime] of this.physicsBodies) {
        if (this.physicsBodyStates.get(id)?.type !== "dynamic") continue;
        const object = this.models.get(id)?.object;
        if (!object) continue;
        const translation = runtime.body.translation();
        const rotation = runtime.body.rotation();
        object.position.set(translation.x, translation.y, translation.z);
        object.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        object.updateWorldMatrix(true, true);
      }
      const now = performance.now();
      if (this.selectedId && now - this.lastPhysicsUiUpdate >= 160) {
        const selected = this.models.get(this.selectedId);
        if (selected && this.physicsBodyStates.get(selected.id)?.type === "dynamic") this.onModelChange?.(selected);
        this.lastPhysicsUiUpdate = now;
      }
    }
  /**
   * B3-c 物理可观测性：把 Rapier 原始碰撞事件解析成 collisionStart/collisionEnd
   * 交互脚本触发。payload.other 携带对端对象 id（地面/不可解析为 null），脚本经
   * `ctx.event.payload.other` 读取；世界清除后队列不存在时静默跳过。
   */
  protected dispatchPhysicsCollisionEvents(): void {
      const queue = this.physicsEventQueue;
      if (!queue) return;
      queue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
        const owners: PhysicsColliderOwners = this.physicsColliderOwners;
        for (const dispatch of resolvePhysicsCollisionDispatches(handle1, handle2, started, owners)) {
          this.dispatchInteraction(
            dispatch.started ? "collisionStart" : "collisionEnd",
            { kind: "object", modelId: dispatch.modelId },
            { payload: { other: dispatch.other } },
          );
        }
      });
    }
  getSceneAnimation(): SceneAnimationState {
      return structuredClone(this.sceneAnimation);
    }
  /**
   * B3 缺口 5：收集全部碰撞体的世界包围盒数据供调试线框层消费。
   * 纯读取、不触碰渲染器；物理关闭或世界未挂载时返回空数组，
   * 调用方据此隐藏调试层。实现在 rapierPhysicsDebugView（脱离类可单测）。
   */
  collectPhysicsDebugColliders() {
    const world = this.physicsWorld;
    if (!world || !this.rapier) return [];
    return collectPhysicsCuboidDebugEntries(world, this.rapier, this.physicsColliderOwners);
  }
  setSceneAnimation(animation: SceneAnimationState): void {
      this.sceneAnimation = {
        duration: Math.max(animation.duration, 0.1),
        loop: animation.loop,
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
      // 播放头同步收敛进新的播放区间，避免缩小区间后残留越界时间。
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
        // 正向播放到出点后重新播放：回到入点起步。
        this.sceneAnimationTime = range.inPoint;
      } else if (this.sceneAnimationDirection < 0 && this.sceneAnimationTime <= range.inPoint) {
        // 倒放到入点后重新播放：从出点反向起步。
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
      this.orbit.enabled = this.navigationMode !== "firstPerson";
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
      // 只切换方向不改播放状态：播放中立即掉头，暂停时由下一次 play 决定起步边界。
      this.sceneAnimationDirection = direction >= 0 ? 1 : -1;
    }
}
