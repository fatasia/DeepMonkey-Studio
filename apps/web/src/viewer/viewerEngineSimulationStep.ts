import * as THREE from "three";
import { ViewerEngineSimulationWorld } from "./viewerEngineSimulationWorld";

/**
 * Simulation 物理步进宿主层(source-size 拆分,2026-10-04:自
 * viewerEngineSimulation.ts 按仿真子域分文件,代码逐行同源,仅改可见性;语义零变化)。
 *
 * 职责:播放循环固定步进(updatePhysics,经 PhysicsWorldHost 追赶时钟)、
 * T28 手动固定步进(stepPhysicsFrames,调试面板核心能力)、动态刚体位姿回写。
 *
 * 继承关系:ViewerEngineSimulationWorld → 本类,公开/保护方法签名与拆分前
 * 逐字一致,宿主(ViewerEngine 叶子类)API 不变。
 */
export abstract class ViewerEngineSimulationStep extends ViewerEngineSimulationWorld {
  protected updatePhysics(delta: number): void {
      const world = this.physicsWorld;
      if (!world || !this.physicsState.enabled || !this.physicsState.playing) return;
      // 播放即退出回放覆盖:真实刚体位姿重新成为对象位姿的事实来源。
      if (this.physicsReplayFrame) this.clearPhysicsReplayFrame();
      this.physicsHost.advance(delta);
      // 追赶循环内的多步事件已在队列里累积,统一在这里 drain 并派发给交互脚本。
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
   * T28:手动固定步进(单步/N 步)。物理已启用但暂停时也可用——这是调试
   * 面板的核心能力:不经过 host 时钟的追赶循环,直接按 1/60 s 步进求解,
   * 录制钩子、事件派发与对象同步与播放路径完全一致。
   */
  stepPhysicsFrames(count = 1): void {
      const world = this.physicsWorld, queue = this.physicsEventQueue;
      if (!world || !queue || !this.physicsState.enabled) return;
      const steps = THREE.MathUtils.clamp(Math.floor(count) || 1, 1, ViewerEngineSimulationStep.MAX_MANUAL_STEPS);
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
}
