import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { controlAnimation, type AnimationContext } from "./viewerEngineAnimation";
import {
  getModelRootMotionState, setModelAnimationEventActions, setModelAnimationEventSink, setModelRootMotion,
  snapshotModelAnimationEventTrace, updateModelAnimationConsumption, type ModelAnimationEventActionDef,
} from "./viewerEngineRootMotion";

/** 最小编辑器夹具:实例(char)→ Hips → body,加一盏 lamp;引擎公开接口注入等价桩。 */
function createHarness() {
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
  const walk = new THREE.AnimationClip("walk", 1, [new THREE.VectorKeyframeTrack("Hips.position", [0, 1], [0, 0, 0, 1, 0, 0])]);
  const idle = new THREE.AnimationClip("idle", 1, []);
  const mixer = new THREE.AnimationMixer(instance);
  const models = new Map<string, { id: string; visible: boolean; opacity: number; object: THREE.Object3D }>([
    ["char", { id: "char", visible: true, opacity: 1, object: instance }],
    ["lamp", { id: "lamp", visible: true, opacity: 1, object: lamp }],
  ]);
  const setModelTransform = vi.fn((id: string, transform: { position?: [number, number, number] }) => {
    const model = models.get(id);
    if (!model) return false;
    if (transform.position) model.object.position.fromArray(transform.position);
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
    modelAnimationPlaybackStates: new Map([["char", { autoplay: true, loopMode: "loop" }]]),
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
  mixer.clipAction(walk).play();
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
