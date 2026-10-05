import * as THREE from "three";
import type { ScenePhysicsBodyState } from "@bim-studio/contracts";
import type { PrismaticImpulseJoint, RevoluteImpulseJoint, RigidBody } from "@dimforge/rapier3d-compat";
import { objectTransform } from "./sceneObjectUtils";
import { mountRapierGearCoupling, mountRapierJoint, removeMountedRapierJoint } from "./rapierPhysicsJoint";
import { mountRapierCharacterController, removeMountedRapierCharacter } from "./rapierCharacterController";
import { resolvePhysicsCollisionDispatches, type PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";
import { industrialPrefabProxyGroundOffset } from "./industrialPrefabProxy";
import { roadPrefabSegmentColliders, type RoadPrefabSegmentCollider } from "../prefabs/roadPrefabColliders";
import { ViewerEngineSimulationRecording } from "./viewerEngineSimulationRecording";

/** 道路分段碰撞体的偏航轴:分段几何只用绕 y 摆放,与世界竖直轴一致。 */
const ROAD_SEGMENT_Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Simulation 物理世界与刚体宿主层(source-size 拆分,2026-10-04:自
 * viewerEngineSimulation.ts 按仿真子域分文件,代码逐行同源,仅改可见性;语义零变化)。
 *
 * 职责:Rapier 世界挂载(ensurePhysicsWorld)、刚体/碰撞体创建与销毁(含 I3 道路
 * 分段碰撞体)、关节与 T17 齿轮耦合器重建、B3-c 碰撞事件派发接线。
 *
 * 继承关系:ViewerEngineSimulationRecording → 本类,公开/保护方法签名与拆分前
 * 逐字一致,宿主(ViewerEngine 叶子类)API 不变。
 */
export abstract class ViewerEngineSimulationWorld extends ViewerEngineSimulationRecording {
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
        // B3-c:autoDrain 必须关——host.advance 的固定步进追赶循环里一步会跑多次
        // world.step,autoDrain=true 会把中间步的碰撞事件在下一个 step 前静默清掉。
        const eventQueue = new rapier.EventQueue(false);
        const attached = this.physicsHost.attach({
          setGravity: (gravity) => { world.gravity = { ...gravity }; },
          // T28:每个固定步求解后触发调试录制钩子(录制/步计数与求解步一一对应)。
          step: (timestep) => {
            world.timestep = timestep;
            // T17 齿轮耦合:求解前读主动角、写从动位置马达目标(与 Native 逐位同构)。
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
        // 地面不是场景对象,只登记为 null 归属:碰撞事件里作为对端来源,自身不派发。
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
      // I3 道路碰撞体:路径式道路按 linearPrefabSegments 每段一个固定 cuboid,
      // 弯道不再被整路包围盒虚包大片空气。仅 fixed 道路走分段(道路碰撞面是静态语义);
      // dynamic/kinematic 与其余对象维持整包围盒路径,不静默改变质量与角色控制器语义。
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
        // B3-c:没有该标志 Rapier 不生成碰撞事件;body 侧启用后与地面/其它 body 的接触都会入队。
        .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
      if (state.type === "dynamic") collider.setMass(state.mass);
      const colliderHandle = world.createCollider(collider, body);
      this.physicsColliderOwners.set(colliderHandle.handle, id);
      // 角色控制器只挂在 kinematic 刚体上;它靠宿主调用 setNextKinematicTranslation 移动。
      const character = state.type === "kinematic"
        ? mountRapierCharacterController(world, colliderHandle, state.character)
        : undefined;
      this.physicsBodies.set(id, { body, colliderHandle: colliderHandle.handle, initialTransform: objectTransform(object), ...(character ? { character } : {}) });
    }
  /**
   * I3 道路碰撞体:在既有固定刚体上为每个路径分段挂一个带偏航角的 cuboid 碰撞体,
   * 句柄逐个登记进归属表(碰撞事件/调试线框按对象反查与单碰撞体同语义)。
   * 道路恒为静态碰撞面,不承载动态质量与角色控制器;物理关闭时本函数不会被调用,零开销。
   */
  private createRoadSegmentColliders(id: string, state: ScenePhysicsBodyState, body: RigidBody,
    segmentColliders: readonly RoadPrefabSegmentCollider[], worldScale: THREE.Vector3): void {
    const world = this.physicsWorld!, rapier = this.rapier!;
    const object = this.models.get(id)!.object;
    // 分段坐标在代理局部系;代理相对根对象只有 y 向落地偏移,换算到根局部后与整包围盒同一套缩放口径。
    const proxyOffsetY = industrialPrefabProxyGroundOffset(object);
    const handles: number[] = [];
    for (const segment of segmentColliders) {
      const offset = new THREE.Vector3(segment.center.x, segment.center.y + proxyOffsetY, segment.center.z)
        .multiply(worldScale);
      // 分段子对象以 rotation.y = -yaw 摆放,碰撞体保持同一旋向(body 帧即根对象世界旋转帧)。
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
      // 先注销句柄再删 body:同一帧内 drain 到的移除残留事件会被解析成“对端不可解析”。
      // I3 道路碰撞体:主句柄之外的分段碰撞体句柄同批注销,归属表不留悬挂条目。
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
  /** T17:按当前关节装载重建齿轮耦合器;joint 被移除后残留耦合器会访问已释放句柄。 */
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
      // T17:被移除关节上的齿轮耦合器若残留,update 会访问已释放的 joint 句柄。
      if (removed) this.rebuildPhysicsGearCouplings();
    }
  /**
   * B3-c 物理可观测性:把 Rapier 原始碰撞事件解析成 collisionStart/collisionEnd
   * 交互脚本触发。payload.other 携带对端对象 id(地面/不可解析为 null),脚本经
   * `ctx.event.payload.other` 读取;世界清除后队列不存在时静默跳过。
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
}
