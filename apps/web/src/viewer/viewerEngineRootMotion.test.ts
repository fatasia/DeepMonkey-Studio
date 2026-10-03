import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { actionPlayhead } from "./viewerEngineAnimationPlayhead";
import { controlAnimation, getAnimationPlayback, type AnimationContext } from "./viewerEngineAnimation";
import {
  getModelRootMotionAvailability, getModelRootMotionState, resetModelRootMotionPose, setModelAnimationEventActions, setModelAnimationEventSink, setModelRootMotion,
  snapshotModelAnimationEventTrace, updateModelAnimationConsumption, type ModelAnimationEventActionDef,
} from "./viewerEngineRootMotion";

/** 最小编辑器夹具:实例(char)→ Hips → body,加一盏 lamp;引擎公开接口注入等价桩。 */
function createHarness(options: { rotationKeys?: number[]; position?: boolean; once?: boolean } = {}) {
  const instance = new THREE.Group();
  instance.name = "charRoot";
  const hips = new THREE.Group();
  hips.name = "Hips";
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  body.name = "body";
  hips.add(body);
  instance.add(hips);
  const lamp = new THREE.Group();
  lamp.name = "lamp";
  const walkTracks: THREE.KeyframeTrack[] = options.position === false ? [] : [new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 1, 0, 0])];
  // rotationKeys 为 [t0 角, t1 角](绕 Y,弧度);省略则无旋转轨道。
  if (options.rotationKeys) {
    const [a0 = 0, a1 = 0] = options.rotationKeys;
    const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a0);
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a1);
    walkTracks.push(new THREE.QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [...q0.toArray(), ...q1.toArray()]));
  }
  const walk = new THREE.AnimationClip("walk", 1, walkTracks);
  const idle = new THREE.AnimationClip("idle", 1, []);
  const mixer = new THREE.AnimationMixer(instance);
  const models = new Map<string, { id: string; visible: boolean; opacity: number; object: THREE.Object3D }>([
    ["char", { id: "char", visible: true, opacity: 1, object: instance }],
    ["lamp", { id: "lamp", visible: true, opacity: 1, object: lamp }],
  ]);
  const setModelTransform = vi.fn((id: string, transform: { position?: [number, number, number]; rotation?: [number, number, number] }) => {
    const model = models.get(id);
    if (!model) return false;
    if (transform.position) model.object.position.fromArray(transform.position);
    if (transform.rotation) model.object.rotation.fromArray([...transform.rotation, model.object.rotation.order]);
    return true;
  });
  const setVisible = vi.fn((id: string, visible: boolean) => {
    const model = models.get(id);
    if (model) model.visible = visible;
  });
  const setOpacity = vi.fn((id: string, opacity: number) => {
    const model = models.get(id);
    if (model) model.opacity = opacity;
  });
  const context = {
    mixers: new Map([["char", mixer]]),
    animationClips: new Map([["char", [walk, idle]]]),
    animationClipSelection: new Map([["char", "walk"]]),
    animationEnabledIds: new Set<string>(["char"]),
    modelAnimationPlaybackStates: new Map([["char", { autoplay: true, loopMode: options.once ? "once" : "loop" }]]),
    models,
    onModelChange: vi.fn(),
    dispatchObjectLifecycle: vi.fn(),
    applyModelAnimationLoopPolicy: vi.fn(),
    getModelTransform: (id: string) => {
      const object = models.get(id)?.object;
      if (!object) return undefined;
      const { position, rotation, scale } = object;
      return {
        position: { x: position.x, y: position.y, z: position.z },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
        scale: { x: scale.x, y: scale.y, z: scale.z },
      };
    },
    setModelTransform,
    setVisible,
    setOpacity,
  } as unknown as AnimationContext;
  // 与生产链一致:播放集合内的模型由 mixer 驱动姿态(未启用消费时它是唯一动果)。
  const walkAction = mixer.clipAction(walk);
  if (options.once) {
    walkAction.setLoop(THREE.LoopOnce, 1);
    walkAction.clampWhenFinished = true;
  }
  walkAction.play();
  const advance = (delta: number) => {
    mixer.update(delta);
    updateModelAnimationConsumption(context, delta);
  };
  return { context, instance, hips, mixer, walk, idle, models, setModelTransform, setVisible, setOpacity, advance };
}

describe("viewerEngineRootMotion 消费切片", () => {
  it("开关关闭且未注册事件时零行为:不改实例 transform、不触发动作、不产生轨迹", () => {
    const harness = createHarness();
    harness.mixer.update(0.3);
    updateModelAnimationConsumption(harness.context, 0.3);
    expect(harness.setModelTransform).not.toHaveBeenCalled();
    expect(harness.setVisible).not.toHaveBeenCalled();
    expect(harness.setOpacity).not.toHaveBeenCalled();
    expect(harness.instance.position.x).toBe(0);
    expect(harness.hips.position.x).toBeCloseTo(0.3, 6);
    expect(getModelRootMotionState(harness.context, "char").enabled).toBe(false);
    expect(snapshotModelAnimationEventTrace(harness.context)).toEqual([]);
  });

  it("根运动把未包裹位移应用到实例并把被跟踪节点钳回轨道起点", () => {
    const harness = createHarness();
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" })).toBe(true);
    harness.advance(0.3);
    harness.advance(0.3);
    harness.advance(0.3);
    expect(harness.instance.position.x).toBeCloseTo(0.9, 6);
    expect(harness.hips.position.x).toBeCloseTo(0, 6);
    const state = getModelRootMotionState(harness.context, "char");
    expect(state.trackResolved).toBe(true);
    expect(state.appliedTranslation[0]).toBeCloseTo(0.9, 6);
    expect(state.lastTranslation?.[0]).toBeCloseTo(0.3, 6);
    expect(harness.setVisible).not.toHaveBeenCalled();
  });

  it("循环回绕做段采样校正:跨圈位移持续前向而非回跳", () => {
    const harness = createHarness();
    setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" });
    harness.advance(0.9);
    expect(harness.instance.position.x).toBeCloseTo(0.9, 6);
    harness.advance(0.2);
    expect(harness.instance.position.x).toBeCloseTo(1.1, 6);
    expect(getModelRootMotionState(harness.context, "char").lastTranslation?.[0]).toBeCloseTo(0.2, 6);
  });

  it("一次大 delta 跨多圈:逐圈位移线性累计且实例净位移等于跨越时长", () => {
    const harness = createHarness();
    setModelRootMotion(harness.context, "char", { enabled: true });
    harness.advance(3.5);
    expect(harness.instance.position.x).toBeCloseTo(3.5, 6);
  });

  it("事件动作:同刻多个动作按注册序各触发一次,notify 送宿主出口,T31 轨迹记录 applied", () => {
    const harness = createHarness();
    const sink = vi.fn();
    setModelAnimationEventSink(harness.context, sink);
    const defs: ModelAnimationEventActionDef[] = [
      { clipId: "walk", eventId: "evtVisible", time: 0.5, action: { kind: "visible", targetId: "lamp", value: false } },
      { clipId: "walk", eventId: "evtOpacity", time: 0.5, action: { kind: "opacity", targetId: "lamp", value: 0.25 } },
      { clipId: "walk", eventId: "evtAlarm", time: 0.5, action: { kind: "notify", name: "alarm" } },
    ];
    expect(setModelAnimationEventActions(harness.context, "char", defs)).toBe(true);
    harness.advance(0.6);
    expect(harness.setVisible).toHaveBeenCalledTimes(1);
    expect(harness.setVisible).toHaveBeenCalledWith("lamp", false);
    expect(harness.setOpacity).toHaveBeenCalledTimes(1);
    expect(harness.setOpacity).toHaveBeenCalledWith("lamp", 0.25);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ modelId: "char", clipId: "walk", eventId: "evtAlarm", loop: 0 }));
    const trace = snapshotModelAnimationEventTrace(harness.context);
    expect(trace.map((entry) => entry.eventNodeId)).toEqual(["evtVisible", "evtOpacity", "evtAlarm"]);
    expect(trace.every((entry) => entry.outcome === "applied" && entry.graphId === "animation:char")).toBe(true);
    harness.advance(0.1);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("未知目标与未注册 notify 出口按 rejected/skipped 记录,不抛错", () => {
    const harness = createHarness();
    const defs: ModelAnimationEventActionDef[] = [
      { clipId: "walk", eventId: "evtGhost", time: 0.2, action: { kind: "visible", targetId: "ghost", value: false } },
      { clipId: "walk", eventId: "evtNotify", time: 0.4, action: { kind: "notify", name: "alarm" } },
    ];
    setModelAnimationEventActions(harness.context, "char", defs);
    harness.advance(0.5);
    expect(harness.setVisible).not.toHaveBeenCalled();
    const trace = snapshotModelAnimationEventTrace(harness.context);
    expect(trace.find((entry) => entry.eventNodeId === "evtGhost")).toMatchObject({ outcome: "rejected", reason: "unknown-target" });
    expect(trace.find((entry) => entry.eventNodeId === "evtNotify")).toMatchObject({ outcome: "skipped", reason: "no-sink" });
  });

  it("非法注册 fail-closed:未知 clip/time 越界/重复 eventId/非法动作整体拒绝且保留原注册", () => {
    const harness = createHarness();
    const good: ModelAnimationEventActionDef[] = [{ clipId: "walk", eventId: "evtKeep", time: 0.5, action: { kind: "visible", value: false } }];
    expect(setModelAnimationEventActions(harness.context, "char", good)).toBe(true);
    expect(setModelAnimationEventActions(harness.context, "char", [{ clipId: "missing", eventId: "a", time: 0.1, action: { kind: "visible", value: true } }])).toBe(false);
    expect(setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "a", time: 1, action: { kind: "visible", value: true } }])).toBe(false);
    expect(setModelAnimationEventActions(harness.context, "char", [
      { clipId: "walk", eventId: "dup", time: 0.1, action: { kind: "notify", name: "x" } },
      { clipId: "walk", eventId: "dup", time: 0.2, action: { kind: "notify", name: "y" } },
    ])).toBe(false);
    expect(setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "bad", time: 0.1, action: { kind: "teleport" } as never }])).toBe(false);
    expect(setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "oob", time: 0.1, action: { kind: "opacity", value: 1.5 } }])).toBe(false);
    harness.advance(0.6);
    expect(harness.setVisible).toHaveBeenCalledTimes(1);
  });

  it("seek 前跳是瞬移:跳过区间不发射事件、不入账位移,后续前进恰好续算", () => {
    const harness = createHarness();
    const sink = vi.fn();
    setModelAnimationEventSink(harness.context, sink);
    setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "mid", time: 0.5, action: { kind: "notify", name: "tick" } }]);
    setModelRootMotion(harness.context, "char", { enabled: true });
    harness.advance(0.4);
    expect(sink).not.toHaveBeenCalled();
    expect(controlAnimation(harness.context, "char", { action: "seek", time: 0.9 })).toBe(true);
    harness.advance(0.2);
    expect(sink).not.toHaveBeenCalled();
    expect(harness.instance.position.x).toBeCloseTo(0.6, 6);
    harness.advance(0.5);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({ unwrappedTime: 1.5, loop: 1 });
  });

  it("seek 向后重置水位:重新前进后事件重新武装恰一次", () => {
    const harness = createHarness();
    const sink = vi.fn();
    setModelAnimationEventSink(harness.context, sink);
    setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "mid", time: 0.5, action: { kind: "notify", name: "tick" } }]);
    harness.advance(0.8);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(controlAnimation(harness.context, "char", { action: "seek", time: 0.1 })).toBe(true);
    harness.advance(0.2);
    expect(sink).toHaveBeenCalledTimes(1);
    harness.advance(0.3);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]![0]).toMatchObject({ unwrappedTime: 0.5, loop: 0 });
  });

  it("once 模式:镜像与位移钳制在 clip 末,完成后前进零行为", () => {
    const harness = createHarness();
    harness.context.modelAnimationPlaybackStates.set("char", { autoplay: true, loopMode: "once" });
    const sink = vi.fn();
    setModelAnimationEventSink(harness.context, sink);
    setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "mid", time: 0.5, action: { kind: "notify", name: "tick" } }]);
    setModelRootMotion(harness.context, "char", { enabled: true });
    harness.advance(2);
    expect(harness.instance.position.x).toBeCloseTo(1, 6);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(getModelRootMotionState(harness.context, "char").unwrappedTime).toBeCloseTo(1, 6);
    harness.advance(0.5);
    expect(harness.instance.position.x).toBeCloseTo(1, 6);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("暂停(移出播放集合)期间前进零行为,恢复播放后镜像归零重新武装", () => {
    const harness = createHarness();
    const sink = vi.fn();
    setModelAnimationEventSink(harness.context, sink);
    setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "mid", time: 0.5, action: { kind: "notify", name: "tick" } }]);
    setModelRootMotion(harness.context, "char", { enabled: true });
    expect(controlAnimation(harness.context, "char", { action: "pause" })).toBe(true);
    harness.advance(0.7);
    expect(sink).not.toHaveBeenCalled();
    expect(harness.instance.position.x).toBe(0);
    expect(controlAnimation(harness.context, "char", { action: "play" })).toBe(true);
    expect(harness.context.animationEnabledIds.has("char")).toBe(true);
    harness.advance(0.6);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("播放中开启根运动不产生跨越性位移:镜像对齐当前有效播放头", () => {
    const harness = createHarness();
    harness.mixer.update(0.5);
    expect(setModelRootMotion(harness.context, "char", { enabled: true })).toBe(true);
    expect(getModelRootMotionState(harness.context, "char").unwrappedTime).toBeCloseTo(0.5, 6);
    harness.advance(0.1);
    expect(harness.instance.position.x).toBeCloseTo(0.1, 6);
  });

  it("活动 clip 无平移轨道时开关可用但零位移(事件不受影响)", () => {
    const harness = createHarness();
    harness.context.animationClipSelection.set("char", "idle");
    expect(setModelRootMotion(harness.context, "char", { enabled: true })).toBe(true);
    harness.advance(0.4);
    expect(harness.setModelTransform).not.toHaveBeenCalled();
    expect(getModelRootMotionState(harness.context, "char").trackResolved).toBe(false);
  });

  it("rootNode 参数校验:未知节点拒绝且保持原配置", () => {
    const harness = createHarness();
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "missing" })).toBe(false);
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "" })).toBe(false);
    expect(setModelRootMotion(harness.context, "ghost", { enabled: true })).toBe(false);
    expect(getModelRootMotionState(harness.context, "char").enabled).toBe(false);
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" })).toBe(true);
    expect(getModelRootMotionState(harness.context, "char")).toMatchObject({ enabled: true, rootNode: "Hips" });
  });

  it("T31 轨迹确定性:seq 单调、atMs 随帧时钟推进、字段完整", () => {
    const harness = createHarness();
    setModelAnimationEventSink(harness.context, vi.fn());
    setModelAnimationEventActions(harness.context, "char", [{ clipId: "walk", eventId: "mid", time: 0.5, action: { kind: "notify", name: "tick" } }]);
    harness.advance(0.6);
    harness.advance(1);
    const trace = snapshotModelAnimationEventTrace(harness.context);
    expect(trace.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(trace[0]!.atMs).toBeCloseTo(600, 6);
    expect(trace[1]!.atMs).toBeCloseTo(1600, 6);
    expect(trace[1]).toMatchObject({ graphId: "animation:char", action: "notify", target: "tick", outcome: "applied" });
  });
});

describe("viewerEngineRootMotion 旋转增量应用", () => {
  const quarterTurn = Math.PI / 2;
  const yawOf = (object: THREE.Object3D) => new THREE.Euler().setFromQuaternion(object.quaternion, "YXZ").y;

  it("旋转增量左乘到实例并把根骨骼旋转钳回轨道起点,不产生双重旋转", () => {
    const harness = createHarness({ rotationKeys: [0, quarterTurn], position: false });
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" })).toBe(true);
    harness.advance(0.5);
    expect(yawOf(harness.instance)).toBeCloseTo(quarterTurn * 0.5, 6);
    expect(harness.hips.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    harness.advance(0.25);
    expect(yawOf(harness.instance)).toBeCloseTo(quarterTurn * 0.75, 6);
    const state = getModelRootMotionState(harness.context, "char");
    expect(state.trackResolved).toBe(true);
    expect(new THREE.Quaternion(...state.appliedRotation).angleTo(harness.instance.quaternion)).toBeCloseTo(0, 6);
    expect(state.lastRotation).not.toBeNull();
    expect(harness.setModelTransform.mock.calls.every(([, payload]) => !("position" in payload))).toBe(true);
  });

  it("循环回绕:跨圈旋转持续前向累计而非回弹到轨道起点", () => {
    const harness = createHarness({ rotationKeys: [0, quarterTurn] });
    setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" });
    harness.advance(0.9);
    harness.advance(0.2);
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), quarterTurn * 1.1);
    expect(harness.instance.quaternion.angleTo(expected)).toBeCloseTo(0, 5);
    harness.advance(2.4);
    const total = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), quarterTurn * 3.5);
    expect(harness.instance.quaternion.angleTo(total)).toBeCloseTo(0, 5);
  });

  it("单位旋转增量不写回:常量旋转轨道只写 position;纯常量旋转轨道不调用 setModelTransform", () => {
    const withPosition = createHarness({ rotationKeys: [0.3, 0.3] });
    setModelRootMotion(withPosition.context, "char", { enabled: true, rootNode: "Hips" });
    withPosition.advance(0.4);
    expect(withPosition.setModelTransform).toHaveBeenCalledTimes(1);
    expect(withPosition.setModelTransform.mock.calls[0]?.[1]).toHaveProperty("position");
    expect(withPosition.setModelTransform.mock.calls[0]?.[1]).not.toHaveProperty("rotation");
    expect(withPosition.instance.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(getModelRootMotionState(withPosition.context, "char").lastRotation).toBeNull();

    const rotationOnly = createHarness({ rotationKeys: [0.3, 0.3], position: false });
    setModelRootMotion(rotationOnly.context, "char", { enabled: true, rootNode: "Hips" });
    rotationOnly.advance(0.4);
    expect(rotationOnly.setModelTransform).not.toHaveBeenCalled();
  });

  it("位置与旋转合并为单次 setModelTransform,payload 对象跨帧复用(帧内零分配)", () => {
    const harness = createHarness({ rotationKeys: [0, quarterTurn] });
    setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" });
    harness.advance(0.2);
    harness.advance(0.2);
    expect(harness.setModelTransform).toHaveBeenCalledTimes(2);
    const first = harness.setModelTransform.mock.calls[0]?.[1];
    expect(first).toHaveProperty("position");
    expect(first).toHaveProperty("rotation");
    expect(harness.setModelTransform.mock.calls[1]?.[1]).toBe(first);
  });

  it("世界旋转共轭:实例已转 90° 时,骨骼父空间增量按世界轴等价应用", () => {
    const harness = createHarness({ rotationKeys: [0, quarterTurn], position: false });
    harness.instance.rotation.set(0, 0, quarterTurn);
    harness.instance.updateMatrixWorld(true);
    setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" });
    harness.advance(1);
    // 父空间 Y 增量 90°,实例绕 Z 转了 90° 后,世界 Y 轴增量 = R·Y·R⁻¹ 轴为世界 -X:世界旋转 = Rz90·Ry90。
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), quarterTurn)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), quarterTurn));
    expect(harness.instance.quaternion.angleTo(expected)).toBeCloseTo(0, 5);
  });

  it("开关关闭零行为:旋转轨道由 mixer 正常驱动,不写实例、不钳节点", () => {
    const harness = createHarness({ rotationKeys: [0, quarterTurn] });
    harness.advance(0.5);
    expect(harness.setModelTransform).not.toHaveBeenCalled();
    expect(harness.instance.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(yawOf(harness.hips)).toBeCloseTo(quarterTurn * 0.5, 6);
    expect(getModelRootMotionState(harness.context, "char").appliedRotation).toEqual([0, 0, 0, 1]);
  });
});

describe("viewerEngineRootMotion 复位与可用性", () => {
  it("开启时记录基线,复位把位置与朝向还原并清零累计量,开关状态不变", () => {
    const harness = createHarness({ rotationKeys: [0, Math.PI / 2] });
    harness.instance.position.set(1, 2, 3);
    setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" });
    harness.advance(0.5);
    expect(harness.instance.position.x).toBeGreaterThan(1.2);
    expect(resetModelRootMotionPose(harness.context, "char")).toBe(true);
    expect(harness.instance.position.toArray()).toEqual([1, 2, 3]);
    expect(harness.instance.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    const state = getModelRootMotionState(harness.context, "char");
    expect(state.enabled).toBe(true);
    expect(state.appliedTranslation).toEqual([0, 0, 0]);
    expect(state.lastRotation).toBeNull();
  });

  it("从未开启过则无基线,复位返回 false 且不写实例", () => {
    const harness = createHarness();
    expect(resetModelRootMotionPose(harness.context, "char")).toBe(false);
    expect(harness.setModelTransform).not.toHaveBeenCalled();
  });

  it("可用性探测:有平移轨道可用;无平移轨道/无动画给出原因", () => {
    const walk = createHarness({ rotationKeys: [0, 1] });
    expect(getModelRootMotionAvailability(walk.context, "char")).toEqual({ available: true, translation: true, rotation: true });
    const rotationOnly = createHarness({ rotationKeys: [0, 1], position: false });
    expect(getModelRootMotionAvailability(rotationOnly.context, "char")).toEqual({
      available: false, reason: "no-root-track", translation: false, rotation: true,
    });
    expect(getModelRootMotionAvailability(walk.context, "ghost").reason).toBe("no-animation");
  });

  it("仅有旋转轨道时缺省 rootNode 不把任意骨骼旋转当根运动;显式 rootNode 才应用", () => {
    const harness = createHarness({ rotationKeys: [0, Math.PI / 2], position: false });
    setModelRootMotion(harness.context, "char", { enabled: true });
    harness.advance(0.5);
    expect(getModelRootMotionState(harness.context, "char").trackResolved).toBe(false);
    expect(harness.instance.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
  });
});

describe("viewerEngineRootMotion 播放头相位(审查修复)", () => {
  it("mixer.time 已累计时 play 后开启:镜像从 action 播放头起算,相位与位移正确", () => {
    const harness = createHarness();
    harness.mixer.update(2.3); // 全局 mixer.time 累计,play 只重置 action
    expect(controlAnimation(harness.context, "char", { action: "play" })).toBe(true);
    harness.mixer.update(0.4);
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" })).toBe(true);
    expect(getModelRootMotionState(harness.context, "char").unwrappedTime).toBeCloseTo(0.4, 6);
    harness.advance(0.2);
    expect(harness.instance.position.x).toBeCloseTo(0.2, 6);
    expect(getModelRootMotionState(harness.context, "char").unwrappedTime).toBeCloseTo(0.6, 6);
    expect(harness.hips.position.x).toBeCloseTo(0, 6);
  });

  it("once 模式 mixer.time 已超过 duration 时重新 play 后开启,位移不丢", () => {
    const harness = createHarness({ once: true });
    harness.mixer.update(1.5);
    controlAnimation(harness.context, "char", { action: "play" });
    expect(setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" })).toBe(true);
    expect(getModelRootMotionState(harness.context, "char").unwrappedTime).toBe(0);
    harness.advance(0.4);
    expect(harness.instance.position.x).toBeCloseTo(0.4, 6);
    harness.advance(0.8);
    // 钳在 clip 末:总位移等于整段 1.0,不超出
    expect(harness.instance.position.x).toBeCloseTo(1, 6);
  });

  it("getAnimationPlayback 与根运动同源:取选中 clip 的 action 相位而非全局 mixer.time", () => {
    const harness = createHarness();
    harness.mixer.update(2.3);
    controlAnimation(harness.context, "char", { action: "play" });
    harness.mixer.update(0.2);
    expect(getAnimationPlayback(harness.context, "char")?.time).toBeCloseTo(0.2, 6);
    const once = createHarness({ once: true });
    once.mixer.update(1.5);
    controlAnimation(once.context, "char", { action: "play" });
    once.mixer.update(0.3);
    expect(getAnimationPlayback(once.context, "char")?.time).toBeCloseTo(0.3, 6);
  });

  it("actionPlayhead:action 未调度时回退 mixer.time,调度后取 action.time(loop 折回/once 钳制)", () => {
    const clip = new THREE.AnimationClip("c", 1, [new THREE.VectorKeyframeTrack("n.position", [0, 1], [0, 0, 0, 1, 0, 0])]);
    const mixer = new THREE.AnimationMixer(new THREE.Group());
    const action = mixer.clipAction(clip);
    mixer.update(0.6);
    expect(actionPlayhead(mixer, clip, "loop")).toBeCloseTo(0.6, 6);
    action.play();
    mixer.update(0.7);
    expect(actionPlayhead(mixer, clip, "loop")).toBeCloseTo(0.7, 6);
    expect(actionPlayhead(mixer, new THREE.AnimationClip("empty", 0, []), "loop")).toBe(0);
    const onceMixer = new THREE.AnimationMixer(new THREE.Group());
    onceMixer.update(3);
    const onceAction = onceMixer.clipAction(clip);
    onceAction.setLoop(THREE.LoopOnce, 1);
    onceAction.clampWhenFinished = true;
    onceAction.play();
    onceMixer.update(5);
    expect(actionPlayhead(onceMixer, clip, "once")).toBe(1);
  });
  it("lastTranslation 预分配:前进前/复位后为 null,前进后快照为独立冻结副本", () => {
    const harness = createHarness();
    setModelRootMotion(harness.context, "char", { enabled: true, rootNode: "Hips" });
    expect(getModelRootMotionState(harness.context, "char").lastTranslation).toBeNull();
    harness.advance(0.3);
    const first = getModelRootMotionState(harness.context, "char").lastTranslation;
    expect(first?.[0]).toBeCloseTo(0.3, 6);
    harness.advance(0.2);
    expect(first?.[0]).toBeCloseTo(0.3, 6);
    expect(getModelRootMotionState(harness.context, "char").lastTranslation?.[0]).toBeCloseTo(0.2, 6);
    resetModelRootMotionPose(harness.context, "char");
    expect(getModelRootMotionState(harness.context, "char").lastTranslation).toBeNull();
  });
});