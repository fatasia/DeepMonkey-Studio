import {
  relativeOffsetAlongAxis,
  relativeRateAlongAxis,
  relativeRotationAroundAxis,
  type PhysicsDebugBodySnapshot,
  type PhysicsDebugFilter,
  type PhysicsDebugJointSnapshot,
  type PhysicsDebugLayers,
  type PhysicsDebugSnapshot,
} from "./physicsDebugSnapshot";
import { collectPhysicsDebugEntries } from "./rapierPhysicsDebugView";
import { collectPhysicsContactPoints } from "./rapierPhysicsDebugContacts";
import type { PhysicsDebugJointViz } from "./rapierPhysicsDebugJoints";
import { ViewerEngineSimulationStep } from "./viewerEngineSimulationStep";

/** 向量经四元数旋转(关节局部轴 → 世界方向;调试图层消费)。 */
function rotateVectorByQuaternion(vector: { x: number; y: number; z: number },
  quaternion: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  // v' = v + 2·(q.xyz × (q.xyz × v + w·v)) 的展开式(单位四元数)。
  const tx = 2 * (quaternion.y * vector.z - quaternion.z * vector.y);
  const ty = 2 * (quaternion.z * vector.x - quaternion.x * vector.z);
  const tz = 2 * (quaternion.x * vector.y - quaternion.y * vector.x);
  const cx = quaternion.y * tz - quaternion.z * ty;
  const cy = quaternion.z * tx - quaternion.x * tz;
  const cz = quaternion.x * ty - quaternion.y * tx;
  return {
    x: vector.x + quaternion.w * tx + cx,
    y: vector.y + quaternion.w * ty + cy,
    z: vector.z + quaternion.w * tz + cz,
  };
}

/**
 * Simulation 物理调试视图宿主层(source-size 拆分,2026-10-04:自
 * viewerEngineSimulation.ts 按仿真子域分文件,代码逐行同源,仅改可见性;语义零变化)。
 *
 * 职责:T28 调试面板快照(getPhysicsDebugSnapshot)、B3 缺口 5 碰撞体线框数据、
 * T0 刀 3 三路调试图层接线(筛选/图层开关/帧同步 updatePhysicsDebugView)、
 * 关节世界系可视化条目(collectPhysicsDebugJointViz)。
 *
 * 继承关系:ViewerEngineSimulationStep → 本类,公开/保护方法签名与拆分前
 * 逐字一致,宿主(ViewerEngine 叶子类)API 不变。
 */
export abstract class ViewerEngineSimulationDebug extends ViewerEngineSimulationStep {
  /**
   * T28:调试面板快照(刚体位置/速度/睡眠 + 关节角度/限位/马达)。
   * 纯读取;世界未挂载时 available=false,面板据此显示引导态。
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
      const allColliders = this.collectPhysicsDebugColliders();
      return {
        available: world !== undefined,
        enabled: this.physicsState.enabled,
        playing: this.physicsState.playing,
        fixedStepIndex: this.physicsFixedStepCount,
        bodies,
        joints,
        debug: {
          colliderCount: this.physicsDebugVisible ? this.filterColliderEntries(allColliders).length : allColliders.length,
          contactCount: this.lastContactSampled,
          jointCount: joints.length,
        },
      };
    }
  /**
   * B3 缺口 5:收集全部碰撞体的世界包围盒数据供调试线框层消费。
   * 纯读取、不触碰渲染器;物理关闭或世界未挂载时返回空数组,
   * 调用方据此隐藏调试层。实现在 rapierPhysicsDebugView(脱离类可单测)。
   */
  collectPhysicsDebugColliders() {
    const world = this.physicsWorld;
    if (!world || !this.rapier) return [];
    return collectPhysicsDebugEntries(world, this.rapier, this.physicsColliderOwners);
  }
  /**
   * T0 刀 3:按体筛选(全部/动态/运动学/静态/选中对象)。
   * selected 依赖 selectedId——由 UI 在切换筛选时一并传入,避免引擎反向暴露选中态。
   */
  setPhysicsDebugFilter(filter: PhysicsDebugFilter, selectedId?: string): void {
    this.physicsDebugFilter = filter;
    if (selectedId !== undefined) this.physicsDebugSelectedId = selectedId;
    if (this.physicsDebugVisible) {
      this.updatePhysicsDebugView();
      this.requestRender();
    }
  }
  getPhysicsDebugFilter(): PhysicsDebugFilter {
    return this.physicsDebugFilter;
  }
  /** T0 刀 3:调试图层独立开关(碰撞体/接触点/约束轴线三路)。 */
  setPhysicsDebugLayers(layers: PhysicsDebugLayers): void {
    this.physicsDebugLayers = layers;
    if (this.physicsDebugVisible) {
      this.updatePhysicsDebugView();
      this.requestRender();
    }
  }
  getPhysicsDebugLayers(): PhysicsDebugLayers {
    return this.physicsDebugLayers;
  }
  /**
   * B3 缺口 5:碰撞体调试线框开关。关闭时三组图层全部 visible=false 且帧同步入口
   * 直接早退(不再收集碰撞/接触数据,零开销、场景零残留);开启时立即同步一次
   * 并请求重绘,不等下一帧。
   */
  setPhysicsDebugVisible(enabled: boolean): void {
    this.physicsDebugVisible = enabled;
    this.physicsDebugOverlay.setVisible(enabled);
    this.physicsJointDebugLayer.setVisible(enabled);
    this.physicsContactDebugLayer.setVisible(enabled);
    if (!enabled) {
      this.lastContactSampled = 0;
      return;
    }
    this.updatePhysicsDebugView();
    this.requestRender();
  }
  isPhysicsDebugVisible(): boolean {
    return this.physicsDebugVisible;
  }
  /**
   * T0 刀 3:调试图层筛选的碰撞体条目集合。selected 模式只留选中对象;
   * 类型模式保留该类型刚体(默认地面归属 null 归入 static 语义)。
   */
  private filterColliderEntries(entries: ReturnType<ViewerEngineSimulationDebug["collectPhysicsDebugColliders"]>) {
    const filter = this.physicsDebugFilter;
    if (filter === "all") return entries;
    if (filter === "selected") return entries.filter((entry) => entry.modelId !== null && entry.modelId === this.physicsDebugSelectedId);
    return entries.filter((entry) => {
      if (entry.modelId === null) return filter === "fixed";
      const type = this.physicsBodyStates.get(entry.modelId)?.type;
      return type === filter;
    });
  }
  /** 线框着色:选中聚焦白色优先;无主=地面;其余按刚体类型(缺登记按静态兜底)。 */
  private resolveColliderEntryKind(entry: { modelId: string | null }) {
    if (this.physicsDebugFilter === "selected" && entry.modelId !== null && entry.modelId === this.physicsDebugSelectedId) return "selected";
    if (entry.modelId === null) return "ground";
    const type = this.physicsBodyStates.get(entry.modelId)?.type;
    return type === "dynamic" || type === "kinematic" ? type : "fixed";
  }
  /**
   * T0 刀 3:把作者态关节组装为世界系可视化条目(锚点=从动体世界位姿,
   * 轴=axis 经连接体(或世界)帧旋转;行程/限位判定与面板快照同一套纯函数)。
   */
  collectPhysicsDebugJointViz(): PhysicsDebugJointViz[] {
    const world = this.physicsWorld;
    if (!world) return [];
    const filter = this.physicsDebugFilter;
    const result: PhysicsDebugJointViz[] = [];
    for (const joint of this.physicsState.joints ?? []) {
      const childRuntime = this.physicsBodies.get(joint.bodyId);
      if (!childRuntime) continue;
      if (filter === "selected" && joint.bodyId !== this.physicsDebugSelectedId && joint.connectedBodyId !== this.physicsDebugSelectedId) continue;
      if (filter === "dynamic" || filter === "kinematic" || filter === "fixed") {
        const childType = this.physicsBodyStates.get(joint.bodyId)?.type;
        const connectedType = joint.connectedBodyId ? this.physicsBodyStates.get(joint.connectedBodyId)?.type : undefined;
        if (childType !== filter && connectedType !== filter) continue;
      }
      const connectedRuntime = joint.connectedBodyId ? this.physicsBodies.get(joint.connectedBodyId) : undefined;
      const childTranslation = childRuntime.body.translation();
      const childRotation = childRuntime.body.rotation();
      const connectedPosition = connectedRuntime?.body.translation() ?? { x: 0, y: 0, z: 0 };
      const connectedRotation = connectedRuntime?.body.rotation() ?? { x: 0, y: 0, z: 0, w: 1 };
      const connectedAngvel = connectedRuntime?.body.angvel() ?? { x: 0, y: 0, z: 0 };
      const travel = joint.kind === "prismatic"
        ? relativeOffsetAlongAxis(connectedPosition, connectedRotation, childTranslation, joint.axis)
        : relativeRotationAroundAxis(connectedRotation, childRotation, joint.axis);
      const limitActive = joint.limits.enabled && (joint.solver ?? "impulse") !== "multibody";
      const atLimit = limitActive && (travel <= joint.limits.min + 1e-4 || travel >= joint.limits.max - 1e-4);
      // 轴世界方向:axis 位于关节局部帧;有连接体时随其旋转,无连接体即世界帧。
      const axis = connectedRuntime ? rotateVectorByQuaternion(joint.axis, connectedRotation) : joint.axis;
      result.push({
        id: joint.id,
        kind: joint.kind,
        anchor: { x: childTranslation.x, y: childTranslation.y, z: childTranslation.z },
        axis,
        limits: { ...joint.limits },
        travel,
        limitState: !limitActive ? "disabled" : atLimit ? "at-limit" : "within",
      });
      void connectedAngvel; // 速率口径与面板快照共用时的扩展点;可视化当前只消费位姿。
    }
    return result;
  }
  /**
   * 每帧同步调试线框位姿与数量;未开启时直接返回,物理数据面零轮询。
   * T28:回放覆盖在此逐帧重申——本方法由 runtime 在每个渲染帧、绘制前调用
   * (即使物理暂停),任何作者态回写都会在下一渲染帧被纠正,回放位姿因此
   * 在按需渲染的空闲场景下也稳定成立。
   * T0 刀 3:三路图层(碰撞体/约束/接触)在开关与各自图层开关下同步;
   * 接触点用即时查询读 narrow-phase,物理暂停时仍能看到最后一步接触。
   */
  protected updatePhysicsDebugView(): void {
    if (this.physicsReplayFrame) this.applyPhysicsReplayFrame();
    if (!this.physicsDebugVisible) return;
    const layers = this.physicsDebugLayers;
    const entries = this.filterColliderEntries(this.collectPhysicsDebugColliders());
    this.physicsDebugOverlay.setVisible(layers.colliders);
    this.physicsDebugOverlay.sync(entries, (entry) => this.resolveColliderEntryKind(entry));
    const joints = layers.joints ? this.collectPhysicsDebugJointViz() : [];
    this.physicsJointDebugLayer.setVisible(layers.joints);
    this.physicsJointDebugLayer.sync(joints);
    const world = this.physicsWorld;
    if (layers.contacts && world) {
      const visibleOwners = new Set<string>();
      for (const entry of entries) if (entry.modelId !== null) visibleOwners.add(entry.modelId);
      const collection = collectPhysicsContactPoints(world, this.physicsColliderOwners, visibleOwners);
      this.physicsContactDebugLayer.setVisible(true);
      this.physicsContactDebugLayer.sync(collection.points, collection.normals);
      this.lastContactSampled = collection.sampled;
    } else {
      this.physicsContactDebugLayer.setVisible(false);
      this.lastContactSampled = 0;
    }
  }
}
