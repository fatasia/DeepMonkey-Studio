import type { MountedRapierGearCoupling } from "./rapierPhysicsJoint";
import {
  DEFAULT_PHYSICS_DEBUG_LAYERS,
  type PhysicsDebugFilter,
  type PhysicsDebugLayers,
} from "./physicsDebugSnapshot";
import { PhysicsPoseRecorder, type PhysicsPoseFrame, type RecordedBodyPose } from "./physicsPoseRecorder";
import { ViewerEngineRig } from "./viewerEngineRig";

/**
 * Simulation 物理录制与回放宿主层(source-size 拆分,2026-10-04:自
 * viewerEngineSimulation.ts 按仿真子域分文件,代码逐行同源,仅改可见性——
 * 原类私有字段/方法在本拆分层间改 protected 以供子层访问,对外部消费者
 * 可见面不变;语义零变化)。
 *
 * 职责:T28 物理调试的录制器与回放覆盖(环形录制/位姿导出/回放帧写入与清除)、
 * 固定步计数钩子,以及拆分层共享的物理调试字段声明。
 *
 * 继承关系:ViewerEngineRig → 本类 → ViewerEngineSimulationWorld →
 * ViewerEngineSimulationStep → ViewerEngineSimulationDebug → ViewerEngineSimulation,
 * 公开/保护方法签名与拆分前逐字一致,宿主(ViewerEngine 叶子类)API 不变。
 */
export abstract class ViewerEngineSimulationRecording extends ViewerEngineRig {
  // T28 物理调试:固定步计数(自世界挂载起单调递增)、环形录制器与回放帧。
  protected physicsFixedStepCount = 0;
  protected physicsRecorder: PhysicsPoseRecorder | undefined;
  protected physicsRecordingActive = false;
  protected physicsReplayFrame: PhysicsPoseFrame | undefined;
  /** 手动步进的上限:一次调用最多追 600 步(与默认录制容量同级),防卡帧。 */
  protected static readonly MAX_MANUAL_STEPS = 600;
  /** T17 齿轮耦合器:随关节重建同步重建,world.step 之前逐个驱动。 */
  protected physicsGearCouplings: MountedRapierGearCoupling[] = [];
  /** T0 刀 3:调试图层状态(筛选/选中聚焦/三路开关)与最近接触采样数。 */
  protected physicsDebugFilter: PhysicsDebugFilter = "all";
  protected physicsDebugSelectedId: string | undefined;
  protected physicsDebugLayers: PhysicsDebugLayers = DEFAULT_PHYSICS_DEBUG_LAYERS;
  protected lastContactSampled = 0;

  /**
   * T28:固定步求解后的调试钩子。步计数 +1;录制中则把全部已登记刚体的
   * 世界位姿写入环形缓冲(与 T17 跨端配对的逐步导出同口径)。
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
  /** T28:录制开关。开启时按 capacity(固定步数)新建环形缓冲;关闭保留已录数据直到清空。 */
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
  /** 已录制帧数与容量;未开始过录制时返回 undefined。 */
  getPhysicsRecording(): { frameCount: number; capacity: number; frames: readonly PhysicsPoseFrame[] } | undefined {
      const recorder = this.physicsRecorder;
      if (!recorder) return undefined;
      return { frameCount: recorder.size, capacity: recorder.capacity, frames: recorder.framesAscending() };
    }
  /** 导出 T17 跨端配对格式的位姿 JSON 文本;无录制数据时返回 undefined。 */
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
   * T28:回放覆盖。把录制帧的位姿直接写到场景对象上(仅暂停态可进入;
   * 播放开始时 updatePhysics 会清除覆盖并恢复刚体事实来源)。传 undefined
   * 清除覆盖,并把覆盖过的对象恢复为刚体真实位姿。写入由 updatePhysicsDebugView
   * 在每个渲染帧重申,见该处注释。
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
  /** 回放帧位姿 → 场景对象;仅覆盖录制中登记的对象,未覆盖节点零接触。 */
  protected applyPhysicsReplayFrame(): void {
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
  protected clearPhysicsReplayFrame(): void {
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
}
