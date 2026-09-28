import * as THREE from "three";
import type { SceneAnimationState, SceneCharacterControllerState, ScenePhysicsBodyState, ScenePhysicsState } from "@bim-studio/contracts";
import type { PrismaticImpulseJoint, RevoluteImpulseJoint, RigidBody } from "@dimforge/rapier3d-compat";
import { normalizeAnimationFrameRate, normalizeSceneAnimationPlaybackRange } from "./timeline";
import { applyTransform, objectTransform } from "./sceneObjectUtils";
import { ViewerEngineRig } from "./viewerEngineRig";
import { mountRapierGearCoupling, mountRapierJoint, normalizePhysicsGears, normalizePhysicsJoints, removeMountedRapierJoint,
  type MountedRapierGearCoupling } from "./rapierPhysicsJoint";
import { configureCharacterController, moveRapierCharacter, mountRapierCharacterController, removeMountedRapierCharacter } from "./rapierCharacterController";
import { resolvePhysicsCollisionDispatches, type PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";
import { collectPhysicsCuboidDebugEntries } from "./rapierPhysicsDebugView";
import { PhysicsPoseRecorder, type PhysicsPoseFrame, type RecordedBodyPose } from "./physicsPoseRecorder";
import {
  relativeOffsetAlongAxis,
  relativeRateAlongAxis,
  relativeRotationAroundAxis,
  type PhysicsDebugBodySnapshot,
  type PhysicsDebugJointSnapshot,
  type PhysicsDebugSnapshot,
} from "./physicsDebugSnapshot";
import { industrialPrefabProxyGroundOffset } from "./industrialPrefabProxy";
import { roadPrefabSegmentColliders, type RoadPrefabSegmentCollider } from "../prefabs/roadPrefabColliders";

/** 道路分段碰撞体的偏航轴：分段几何只用绕 y 摆放，与世界竖直轴一致。 */
const ROAD_SEGMENT_Y_AXIS = new THREE.Vector3(0, 1, 0);

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
  // T28 物理调试：固定步计数（自世界挂载起单调递增）、环形录制器与回放帧。
  protected physicsFixedStepCount = 0;
  protected physicsRecorder: PhysicsPoseRecorder | undefined;
  protected physicsRecordingActive = false;
  protected physicsReplayFrame: PhysicsPoseFrame | undefined;
  /** 手动步进的上限：一次调用最多追 600 步（与默认录制容量同级），防卡帧。 */
  private static readonly MAX_MANUAL_STEPS = 600;
  /** T17 齿轮耦合器：随关节重建同步重建，world.step 之前逐个驱动。 */
  private physicsGearCouplings: MountedRapierGearCoupling[] = [];

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
        runtime.body.setLinvel(this.physicsBodyStates.get(id)?.initialLinearVelocity ?? { x: 0, y: 0, z: 0 }, true);
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
          // T28：每个固定步求解后触发调试录制钩子（录制/步计数与求解步一一对应）。
          step: (timestep) => {
            world.timestep = timestep;
            // T17 齿轮耦合：求解前读主动角、写从动位置马达目标（与 Native 逐位同构）。
            for (const coupling of this.physicsGearCouplings) coupling.update();
            world.step(eventQueue);
            this.afterPhysicsFixedStep();
          },
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
      if (state.type === "dynamic") {
        descriptor.setCcdEnabled(true).setLinearDamping(0.08).setAngularDamping(0.12);
        if (state.initialLinearVelocity) descriptor.setLinvel(state.initialLinearVelocity.x, state.initialLinearVelocity.y, state.initialLinearVelocity.z);
      }
      const body = world.createRigidBody(descriptor);
      // I3 道路碰撞体：路径式道路按 linearPrefabSegments 每段一个固定 cuboid，
      // 弯道不再被整路包围盒虚包大片空气。仅 fixed 道路走分段（道路碰撞面是静态语义）；
      // dynamic/kinematic 与其余对象维持整包围盒路径，不静默改变质量与角色控制器语义。
      const segmentColliders = state.type === "fixed"
        ? roadPrefabSegmentColliders(this.modelPrefabStates.get(id))
        : [];
      if (segmentColliders.length) {
        this.createRoadSegmentColliders(id, state, body, segmentColliders, worldScale);
        return;
      }
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
  /**
   * I3 道路碰撞体：在既有固定刚体上为每个路径分段挂一个带偏航角的 cuboid 碰撞体，
   * 句柄逐个登记进归属表（碰撞事件/调试线框按对象反查与单碰撞体同语义）。
   * 道路恒为静态碰撞面，不承载动态质量与角色控制器；物理关闭时本函数不会被调用，零开销。
   */
  private createRoadSegmentColliders(id: string, state: ScenePhysicsBodyState, body: RigidBody,
    segmentColliders: readonly RoadPrefabSegmentCollider[], worldScale: THREE.Vector3): void {
    const world = this.physicsWorld!, rapier = this.rapier!;
    const object = this.models.get(id)!.object;
    // 分段坐标在代理局部系；代理相对根对象只有 y 向落地偏移，换算到根局部后与整包围盒同一套缩放口径。
    const proxyOffsetY = industrialPrefabProxyGroundOffset(object);
    const handles: number[] = [];
    for (const segment of segmentColliders) {
      const offset = new THREE.Vector3(segment.center.x, segment.center.y + proxyOffsetY, segment.center.z)
        .multiply(worldScale);
      // 分段子对象以 rotation.y = -yaw 摆放，碰撞体保持同一旋向（body 帧即根对象世界旋转帧）。
      const rotation = new THREE.Quaternion().setFromAxisAngle(ROAD_SEGMENT_Y_AXIS, -segment.yawRadians);
      const collider = rapier.ColliderDesc.cuboid(
        Math.max(Math.abs(segment.halfExtents.x * worldScale.x), 0.01),
        Math.max(Math.abs(segment.halfExtents.y * worldScale.y), 0.01),
        Math.max(Math.abs(segment.halfExtents.z * worldScale.z), 0.01)
      ).setTranslation(offset.x, offset.y, offset.z).setRotation(rotation)
        .setFriction(state.friction).setRestitution(state.restitution)
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
      const handle = world.createCollider(collider, body).handle;
      this.physicsColliderOwners.set(handle, id);
      handles.push(handle);
    }
    this.physicsBodies.set(id, {
      body,
      colliderHandle: handles[0]!,
      initialTransform: objectTransform(object),
      extraColliderHandles: handles.slice(1),
    });
  }
  protected removePhysicsBody(id: string): void {
      this.removePhysicsJointsForBody(id);
      const runtime = this.physicsBodies.get(id);
      if (runtime?.character && this.physicsWorld) removeMountedRapierCharacter(this.physicsWorld, runtime.character);
      if (runtime && this.physicsWorld) this.physicsWorld.removeRigidBody(runtime.body);
      // 先注销句柄再删 body：同一帧内 drain 到的移除残留事件会被解析成“对端不可解析”。
      // I3 道路碰撞体：主句柄之外的分段碰撞体句柄同批注销，归属表不留悬挂条目。
      if (runtime) {
        this.physicsColliderOwners.delete(runtime.colliderHandle);
        for (const handle of runtime.extraColliderHandles ?? []) this.physicsColliderOwners.delete(handle);
      }
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
      this.rebuildPhysicsGearCouplings();
    }
  /** T17：按当前关节装载重建齿轮耦合器；joint 被移除后残留耦合器会访问已释放句柄。 */
  private rebuildPhysicsGearCouplings(): void {
      this.physicsGearCouplings = [];
      const jointStates = new Map((this.physicsState.joints ?? []).map(state => [state.id, state]));
      for (const gear of this.physicsState.gears ?? []) {
        const driverState = jointStates.get(gear.driverJointId), followerState = jointStates.get(gear.followerJointId);
        const driver = this.physicsJoints.get(gear.driverJointId), follower = this.physicsJoints.get(gear.followerJointId);
        const driverBody = driverState ? this.physicsBodies.get(driverState.bodyId)?.body : undefined;
        const followerBody = followerState ? this.physicsBodies.get(followerState.bodyId)?.body : undefined;
        if (!driverState || !followerState || driver?.solver !== "impulse" || follower?.solver !== "impulse"
          || !driverBody || !followerBody) continue;
        // solver 已确保 impulse 装载;joint 联合类型在此收窄为单位冲量关节。
        const driverJoint = driver.joint as RevoluteImpulseJoint | PrismaticImpulseJoint;
        const followerJoint = follower.joint as RevoluteImpulseJoint | PrismaticImpulseJoint;
        this.physicsGearCouplings.push(mountRapierGearCoupling(this.rapier!,
          { kind: driverState.kind, axis: driverState.axis, body: driverBody, joint: driverJoint },
          { kind: followerState.kind, axis: followerState.axis, body: followerBody, joint: followerJoint },
          { ratio: gear.ratio, stiffness: gear.stiffness, damping: gear.damping },
        ));
      }
    }
  protected removePhysicsJointsForBody(bodyId: string): void {
      const world = this.physicsWorld;
      if (!world) return;
      const states = new Map((this.physicsState.joints ?? []).map((joint) => [joint.id, joint]));
      let removed = false;
      for (const [id, joint] of this.physicsJoints) {
        const state = states.get(id);
        if (state?.bodyId !== bodyId && state?.connectedBodyId !== bodyId) continue;
        removeMountedRapierJoint(world, joint);
        this.physicsJoints.delete(id);
        removed = true;
      }
      // T17：被移除关节上的齿轮耦合器若残留，update 会访问已释放的 joint 句柄。
      if (removed) this.rebuildPhysicsGearCouplings();
    }
  protected updatePhysics(delta: number): void {
      const world = this.physicsWorld;
      if (!world || !this.physicsState.enabled || !this.physicsState.playing) return;
      // 播放即退出回放覆盖：真实刚体位姿重新成为对象位姿的事实来源。
      if (this.physicsReplayFrame) this.clearPhysicsReplayFrame();
      this.physicsHost.advance(delta);
      // 追赶循环内的多步事件已在队列里累积，统一在这里 drain 并派发给交互脚本。
      this.dispatchPhysicsCollisionEvents();
      this.syncDynamicBodiesToObjects();
      const now = performance.now();
      if (this.selectedId && now - this.lastPhysicsUiUpdate >= 160) {
        const selected = this.models.get(this.selectedId);
        if (selected && this.physicsBodyStates.get(selected.id)?.type === "dynamic") this.onModelChange?.(selected);
        this.lastPhysicsUiUpdate = now;
      }
    }
  /** 动态刚体求解位姿 → 场景对象。播放循环与手动步进共用同一同步路径。 */
  protected syncDynamicBodiesToObjects(): void {
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
    }
  /**
   * T28：固定步求解后的调试钩子。步计数 +1；录制中则把全部已登记刚体的
   * 世界位姿写入环形缓冲（与 T17 跨端配对的逐步导出同口径）。
   */
  protected afterPhysicsFixedStep(): void {
      this.physicsFixedStepCount += 1;
      const recorder = this.physicsRecorder;
      if (!recorder || !this.physicsRecordingActive) return;
      const bodies: RecordedBodyPose[] = [];
      for (const [id, runtime] of this.physicsBodies) {
        const translation = runtime.body.translation();
        const rotation = runtime.body.rotation();
        bodies.push({ id, p: [translation.x, translation.y, translation.z], q: [rotation.x, rotation.y, rotation.z, rotation.w] });
      }
      recorder.recordFrame({ step: this.physicsFixedStepCount, bodies });
    }
  /**
   * T28：手动固定步进（单步/N 步）。物理已启用但暂停时也可用——这是调试
   * 面板的核心能力：不经过 host 时钟的追赶循环，直接按 1/60 s 步进求解，
   * 录制钩子、事件派发与对象同步与播放路径完全一致。
   */
  stepPhysicsFrames(count = 1): void {
      const world = this.physicsWorld, queue = this.physicsEventQueue;
      if (!world || !queue || !this.physicsState.enabled) return;
      const steps = THREE.MathUtils.clamp(Math.floor(count) || 1, 1, ViewerEngineSimulation.MAX_MANUAL_STEPS);
      if (this.physicsReplayFrame) this.clearPhysicsReplayFrame();
      for (let index = 0; index < steps; index += 1) {
        world.timestep = 1 / 60;
        world.step(queue);
        this.afterPhysicsFixedStep();
      }
      this.syncDynamicBodiesToObjects();
      this.dispatchPhysicsCollisionEvents();
      this.requestRender();
    }
  /** T28：录制开关。开启时按 capacity（固定步数）新建环形缓冲；关闭保留已录数据直到清空。 */
  setPhysicsRecording(active: boolean, capacity = 600): void {
      if (active) {
        this.physicsRecorder = new PhysicsPoseRecorder(Math.max(1, Math.round(capacity)));
        this.physicsRecordingActive = true;
      } else if (this.physicsRecorder) {
        this.physicsRecordingActive = false;
      }
    }
  isPhysicsRecording(): boolean {
      return this.physicsRecordingActive;
    }
  clearPhysicsRecording(): void {
      this.physicsRecorder = undefined;
      this.physicsRecordingActive = false;
    }
  /** 已录制帧数与容量；未开始过录制时返回 undefined。 */
  getPhysicsRecording(): { frameCount: number; capacity: number; frames: readonly PhysicsPoseFrame[] } | undefined {
      const recorder = this.physicsRecorder;
      if (!recorder) return undefined;
      return { frameCount: recorder.size, capacity: recorder.capacity, frames: recorder.framesAscending() };
    }
  /** 导出 T17 跨端配对格式的位姿 JSON 文本；无录制数据时返回 undefined。 */
  exportPhysicsPoseJson(): string | undefined {
      const recorder = this.physicsRecorder;
      if (!recorder || recorder.size === 0) return undefined;
      return JSON.stringify(recorder.toPoseJson({
        end: "web",
        scenario: "editor-capture",
        fixedStepSeconds: 1 / 60,
        gravity: [this.physicsState.gravity.x, this.physicsState.gravity.y, this.physicsState.gravity.z],
        enabled: this.physicsState.enabled,
      }));
    }
  /**
   * T28：回放覆盖。把录制帧的位姿直接写到场景对象上（仅暂停态可进入；
   * 播放开始时 updatePhysics 会清除覆盖并恢复刚体事实来源）。传 undefined
   * 清除覆盖，并把覆盖过的对象恢复为刚体真实位姿。写入由 updatePhysicsDebugView
   * 在每个渲染帧重申，见该处注释。
   */
  setPhysicsReplayFrame(frame: PhysicsPoseFrame | undefined): void {
      if (frame) {
        this.physicsReplayFrame = frame;
        this.applyPhysicsReplayFrame();
      } else {
        this.clearPhysicsReplayFrame();
      }
      this.requestRender();
    }
  isPhysicsReplaying(): boolean {
      return this.physicsReplayFrame !== undefined;
    }
  /** 回放帧位姿 → 场景对象；仅覆盖录制中登记的对象，未覆盖节点零接触。 */
  private applyPhysicsReplayFrame(): void {
      const frame = this.physicsReplayFrame;
      if (!frame) return;
      for (const pose of frame.bodies) {
        const object = this.models.get(pose.id)?.object;
        if (!object) continue;
        object.position.set(pose.p[0], pose.p[1], pose.p[2]);
        object.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
        object.updateWorldMatrix(true, true);
      }
    }
  private clearPhysicsReplayFrame(): void {
      const frame = this.physicsReplayFrame;
      this.physicsReplayFrame = undefined;
      if (!frame) return;
      for (const pose of frame.bodies) {
        const runtime = this.physicsBodies.get(pose.id);
        const object = this.models.get(pose.id)?.object;
        if (!runtime || !object) continue;
        const translation = runtime.body.translation();
        const rotation = runtime.body.rotation();
        object.position.set(translation.x, translation.y, translation.z);
        object.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        object.updateWorldMatrix(true, true);
      }
    }
  /**
   * T28：调试面板快照（刚体位置/速度/睡眠 + 关节角度/限位/马达）。
   * 纯读取；世界未挂载时 available=false，面板据此显示引导态。
   */
  getPhysicsDebugSnapshot(): PhysicsDebugSnapshot {
      const world = this.physicsWorld;
      const bodies: PhysicsDebugBodySnapshot[] = [];
      const joints: PhysicsDebugJointSnapshot[] = [];
      if (world) {
        for (const [id, runtime] of this.physicsBodies) {
          const bodyState = this.physicsBodyStates.get(id);
          if (bodyState?.type === "none") continue;
          const translation = runtime.body.translation();
          const rotation = runtime.body.rotation();
          const linvel = runtime.body.linvel();
          const angvel = runtime.body.angvel();
          bodies.push({
            id,
            name: this.models.get(id)?.name ?? id,
            type: bodyState?.type ?? "fixed",
            position: { x: translation.x, y: translation.y, z: translation.z },
            quaternion: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
            linvel: { x: linvel.x, y: linvel.y, z: linvel.z },
            angvel: { x: angvel.x, y: angvel.y, z: angvel.z },
            speed: Math.hypot(linvel.x, linvel.y, linvel.z),
            angularSpeed: Math.hypot(angvel.x, angvel.y, angvel.z),
            sleeping: runtime.body.isSleeping(),
          });
        }
        const bodyById = new Map(bodies.map((body) => [body.id, body]));
        const worldQuaternion = { x: 0, y: 0, z: 0, w: 1 };
        const worldPosition = { x: 0, y: 0, z: 0 };
        const zeroVel = { x: 0, y: 0, z: 0 };
        for (const joint of this.physicsState.joints ?? []) {
          const child = bodyById.get(joint.bodyId);
          if (!child) continue;
          const connected = joint.connectedBodyId ? bodyById.get(joint.connectedBodyId) : undefined;
          const travel = joint.kind === "prismatic"
            ? relativeOffsetAlongAxis(connected?.position ?? worldPosition, connected?.quaternion ?? worldQuaternion, child.position, joint.axis)
            : relativeRotationAroundAxis(connected?.quaternion ?? worldQuaternion, child.quaternion, joint.axis);
          const rate = relativeRateAlongAxis(connected?.angvel ?? zeroVel, connected?.quaternion ?? worldQuaternion, child.angvel, joint.axis);
          const limitActive = joint.limits.enabled && joint.solver !== "multibody";
          const atLimit = limitActive && (travel <= joint.limits.min + 1e-4 || travel >= joint.limits.max - 1e-4);
          joints.push({
            id: joint.id,
            kind: joint.kind,
            solver: joint.solver ?? "impulse",
            bodyName: child.name,
            connectedBodyName: connected?.name ?? "",
            axis: { ...joint.axis },
            limits: { ...joint.limits },
            motor: { ...joint.motor },
            travel,
            rate,
            limitState: !limitActive ? "disabled" : atLimit ? "at-limit" : "within",
          });
        }
      }
      return {
        available: world !== undefined,
        enabled: this.physicsState.enabled,
        playing: this.physicsState.playing,
        fixedStepIndex: this.physicsFixedStepCount,
        bodies,
        joints,
      };
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
  /**
   * B3 缺口 5：碰撞体调试线框开关。关闭时整组 visible=false 且帧同步入口直接
   * 早退（不再收集碰撞数据，零开销）；开启时立即同步一次并请求重绘，不等下一帧。
   */
  setPhysicsDebugVisible(enabled: boolean): void {
    this.physicsDebugVisible = enabled;
    this.physicsDebugOverlay.setVisible(enabled);
    if (!enabled) return;
    this.updatePhysicsDebugView();
    this.requestRender();
  }
  isPhysicsDebugVisible(): boolean {
    return this.physicsDebugVisible;
  }
  /**
   * 每帧同步调试线框位姿与数量；未开启时直接返回，物理数据面零轮询。
   * T28：回放覆盖在此逐帧重申——本方法由 runtime 在每个渲染帧、绘制前调用
   * （即使物理暂停），任何作者态回写都会在下一渲染帧被纠正，回放位姿因此
   * 在按需渲染的空闲场景下也稳定成立。
   */
  protected updatePhysicsDebugView(): void {
    if (this.physicsReplayFrame) this.applyPhysicsReplayFrame();
    if (!this.physicsDebugVisible) return;
    this.physicsDebugOverlay.sync(this.collectPhysicsDebugColliders(), (entry) => {
      // 无主碰撞体=默认地面；有主按刚体类型着色，登记缺失兜底按静态处理。
      if (entry.modelId === null) return "ground";
      const type = this.physicsBodyStates.get(entry.modelId)?.type;
      return type === "dynamic" || type === "kinematic" ? type : "fixed";
    });
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
      // 只切换方向不改播放状态：播放中立即掉头，暂停时由下一次 play 决定起步边界。
      this.sceneAnimationDirection = direction >= 0 ? 1 : -1;
    }
}
