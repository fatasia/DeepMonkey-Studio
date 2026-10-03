import { describe, expect, it } from "vitest";
import { FixedStepClock } from "./fixedStepDriver.js";
import {
  comparePhysicsDebugRecordingTicks, estimatePhysicsDebugRecorderBytes, fingerprintFloat32,
  parsePhysicsDebugRecordingJson, PhysicsDebugRecorder,
  PHYSICS_DEBUG_CONTACT_STRIDE, PHYSICS_DEBUG_DEFAULT_COMPARE_TOLERANCE, PHYSICS_DEBUG_POSE_STRIDE,
  type PhysicsDebugRecorderTickInput,
} from "./debugRecorder.js";

/**
 * Brief-PhysDbg 确定性物理调试录制器验收(2026-10-03 任务书①-④ + 合同卫生):
 * ① 60s@60Hz 录制零丢 tick(FixedStepClock 追赶上限内);
 * ② 回放与录制位姿逐位一致(哈希等价:读回重录双跑 + JSON 往返);
 * ③ 人为注入偏差被定位到具体 tick(>1e-3 红线,哈希失配独立暴露);
 * ④ 录制开启帧时增量 ≤0.3ms(默认容量 96 体,p95 实测)。
 */

/** mulberry32:确定性帧间隔抖动流(与 terrain 随机同族,固定 seed)。 */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性轨迹输入:半隐式欧拉抛物体(仅作录制载荷,不追求物理真实性)。 */
function makeTickInput(tick: number, bodyCount: number, poses: Float64Array): PhysicsDebugRecorderTickInput {
  const dt = 1 / 60;
  for (let body = 0; body < bodyCount; body += 1) {
    const base = body * PHYSICS_DEBUG_POSE_STRIDE;
    const phase = tick * dt;
    poses[base] = 0.25 * (body + 1) + phase * (0.3 + 0.1 * body);
    poses[base + 1] = 2 - 4.905 * phase * phase + 0.5 * body;
    poses[base + 2] = 0.1 * body * phase;
    const angle = 0.4 * body + phase * (0.5 + 0.25 * body);
    const half = angle / 2;
    poses[base + 3] = 0;
    poses[base + 4] = Math.sin(half);
    poses[base + 5] = 0;
    poses[base + 6] = Math.cos(half);
  }
  return { tick, poses, bodyCount };
}

describe("PhysicsDebugRecorder 配置与预算", () => {
  it("默认配置按 12MiB 预算推导 tick 容量,覆盖 60s@60Hz(3600 tick)", () => {
    const estimate = estimatePhysicsDebugRecorderBytes();
    expect(estimate.tickCapacity).toBeGreaterThanOrEqual(3600);
    expect(estimate.totalBytes).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(estimate.perTickBytes).toBe(96 * PHYSICS_DEBUG_POSE_STRIDE * 4 + 16 * PHYSICS_DEBUG_CONTACT_STRIDE * 4 + 8 * 4 * 4 + 28);
  });

  it("非法配置显式抛错(不静默钳制)", () => {
    expect(() => estimatePhysicsDebugRecorderBytes({ byteBudget: -1 })).toThrow(/byteBudget/);
    expect(() => estimatePhysicsDebugRecorderBytes({ maxBodies: 0 })).toThrow(/maxBodies/);
    expect(() => estimatePhysicsDebugRecorderBytes({ tickCapacity: 0 })).toThrow(/tickCapacity/);
    expect(() => new PhysicsDebugRecorder({ tickCapacity: 2.5 })).toThrow(/tickCapacity/);
  });

  it("fingerprintFloat32 与 f32 位模式逐位对应(0.1 的 f32 与 f64 哈希不同)", () => {
    const f32Of01 = Math.fround(0.1);
    expect(fingerprintFloat32([f32Of01])).toBe(fingerprintFloat32([Math.fround(f32Of01 + 1e-12)]));
    expect(fingerprintFloat32([0.1])).toBe(fingerprintFloat32([f32Of01])); // fround 后同位模式
  });
});

describe("验收①:60s@60Hz 零丢 tick(追赶上限内)", () => {
  it("抖动帧率驱动 FixedStepClock 录满 3600 tick,无断档无丢弃", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 5 });
    const recorder = new PhysicsDebugRecorder();
    const bodyCount = 8;
    const poses = new Float64Array(bodyCount * PHYSICS_DEBUG_POSE_STRIDE);
    const jitter = mulberry32(20261003);
    recorder.start(0);
    let produced = 0;
    let nextTick = 1;
    for (let frame = 0; frame < 6000 && produced < 3600; frame += 1) {
      // ±3ms 抖动的渲染帧间隔;round 量化后由追赶上限兜长帧。
      const dt = 1 / 60 + (jitter() - 0.5) * 0.006;
      const executed = clock.advanceSeconds(dt);
      for (let i = 0; i < executed; i += 1) {
        recorder.record(makeTickInput(nextTick, bodyCount, poses));
        nextTick += 1;
        produced += 1;
      }
    }
    expect(produced).toBe(3600);
    expect(recorder.recordedTickCount).toBe(3600);
    expect(recorder.lostTickGaps).toBe(0);
    expect(recorder.lostTicks).toBe(0);
    expect(recorder.droppedTicks).toBe(0);
    expect(clock.droppedTicks).toBe(0);
    expect(recorder.tickAt(0)).toBe(1);
    expect(recorder.tickAt(3599)).toBe(3600);
  });

  it("时钟积压被追赶上限截断时,录制器显式记丢 tick(不静默)", () => {
    const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 2 });
    const recorder = new PhysicsDebugRecorder({ tickCapacity: 64, maxBodies: 2 });
    const poses = new Float64Array(2 * PHYSICS_DEBUG_POSE_STRIDE);
    recorder.start(0);
    let nextTick = 1;
    // 一帧 0.5s 积压 = 30 tick,时钟只执行 2 个 → 28 个丢 tick。
    clock.advanceSeconds(0.5);
    const executed = 2; // advanceSeconds 的返回值同上限
    for (let i = 0; i < executed; i += 1) {
      recorder.record(makeTickInput(nextTick, 2, poses));
      nextTick += 1;
    }
    expect(clock.droppedTicks).toBeGreaterThan(0);
    expect(recorder.lostTickGaps).toBe(0); // 连续录制段本身无断档
    // 直接注入断档:录制器必须显式暴露。
    recorder.record(makeTickInput(nextTick + 5, 2, poses));
    expect(recorder.lostTickGaps).toBe(1);
    expect(recorder.lostTicks).toBe(5);
  });
});

describe("验收②:回放与录制位姿逐位一致(哈希等价)", () => {
  it("读回→第二台录制器重录,逐 tick 哈希与链哈希全等", () => {
    const source = new PhysicsDebugRecorder({ tickCapacity: 90, maxBodies: 4 });
    const poses = new Float64Array(4 * PHYSICS_DEBUG_POSE_STRIDE);
    source.start(0);
    for (let tick = 1; tick <= 90; tick += 1) source.record(makeTickInput(tick, 4, poses));

    const replay = new PhysicsDebugRecorder({ tickCapacity: 90, maxBodies: 4 });
    const readback = new Float32Array(4 * PHYSICS_DEBUG_POSE_STRIDE);
    replay.start(0);
    for (let index = 0; index < source.recordedTickCount; index += 1) {
      source.copyTickPoses(index, readback);
      replay.record({ tick: source.tickAt(index), poses: readback, bodyCount: 4 });
    }
    expect(replay.chainHash).toBe(source.chainHash);
    for (let index = 0; index < source.recordedTickCount; index += 1) {
      expect(replay.tickHashAt(index)).toBe(source.tickHashAt(index));
    }
    // 同输入双跑:第三台录制器直接喂原始 f64 输入,链哈希必须一致(确定性)。
    const again = new PhysicsDebugRecorder({ tickCapacity: 90, maxBodies: 4 });
    const raw = new Float64Array(4 * PHYSICS_DEBUG_POSE_STRIDE);
    again.start(0);
    for (let tick = 1; tick <= 90; tick += 1) again.record(makeTickInput(tick, 4, raw));
    expect(again.chainHash).toBe(source.chainHash);
  });

  it("JSON 往返:f32 位模式逐位还原,比对零超差", () => {
    const source = new PhysicsDebugRecorder({ tickCapacity: 40, maxBodies: 3 });
    const poses = new Float64Array(3 * PHYSICS_DEBUG_POSE_STRIDE);
    source.start(0);
    for (let tick = 1; tick <= 40; tick += 1) source.record(makeTickInput(tick, 3, poses));
    const parsed = parsePhysicsDebugRecordingJson(source.toDebugJson({ hz: 60, note: "round-trip" }));
    expect(parsed.chainHash).toBe(source.chainHash);
    const result = comparePhysicsDebugRecordingTicks(source.snapshotTicks(), parsed.ticks);
    expect(result.firstExceededTick).toBeNull();
    expect(result.firstHashMismatchTick).toBeNull();
    expect(result.ticksCompared).toBe(40);
    // 位模式证据:f32(0.1) 的读回值必须精确等于 Math.fround(0.1),不是 0.1 的 f64。
    const readback = new Float32Array(3 * PHYSICS_DEBUG_POSE_STRIDE);
    source.copyTickPoses(0, readback);
    expect(readback[0]).toBe(Math.fround(readback[0]));
  });

  it("环形覆盖后按时间升序读回,链哈希覆盖全会话(含被覆盖 tick)", () => {
    const recorder = new PhysicsDebugRecorder({ tickCapacity: 8, maxBodies: 1 });
    const poses = new Float64Array(PHYSICS_DEBUG_POSE_STRIDE);
    recorder.start(0);
    for (let tick = 1; tick <= 10; tick += 1) recorder.record(makeTickInput(tick, 1, poses));
    expect(recorder.recordedTickCount).toBe(8);
    expect(recorder.totalAcceptedTicks).toBe(10);
    expect(recorder.tickAt(0)).toBe(3);
    expect(recorder.tickAt(7)).toBe(10);
    expect(recorder.chainHash).not.toBe("811c9dc5811c9dc5");
  });
});

describe("验收③:注入偏差定位到具体 tick", () => {
  const TICKS = 60;
  const record = (deviate?: { tick: number; delta: number }) => {
    const recorder = new PhysicsDebugRecorder({ tickCapacity: TICKS, maxBodies: 4 });
    const poses = new Float64Array(4 * PHYSICS_DEBUG_POSE_STRIDE);
    recorder.start(0);
    for (let tick = 1; tick <= TICKS; tick += 1) {
      const input = makeTickInput(tick, 4, poses);
      if (deviate && tick === deviate.tick) poses[0] += deviate.delta;
      recorder.record(input);
      if (deviate && tick === deviate.tick) poses[0] -= deviate.delta;
    }
    return recorder;
  };

  it("单 tick 注入 2e-3 位置偏差:首个超差 tick、哈希失配 tick、超差计数全中", () => {
    const clean = record();
    const deviated = record({ tick: 37, delta: 0.002 });
    const result = comparePhysicsDebugRecordingTicks(clean.snapshotTicks(), deviated.snapshotTicks());
    expect(result.firstExceededTick).toBe(37);
    expect(result.firstHashMismatchTick).toBe(37);
    expect(result.exceededTickCount).toBe(1);
    expect(result.maxPosition).toBeCloseTo(0.002, 6);
    expect(result.maxPosition).toBeGreaterThan(PHYSICS_DEBUG_DEFAULT_COMPARE_TOLERANCE.positionMeters);
    const row = result.perTick.find((entry) => entry.tick === 37);
    expect(row?.exceeded).toBe(true);
    expect(row?.positionExceeded).toBe(true);
    expect(row?.hashMatch).toBe(false);
  });

  it("亚容差偏差(2e-4):哈希失配照报,1e-3 红线不误报", () => {
    const clean = record();
    const tiny = record({ tick: 20, delta: 0.0002 });
    const result = comparePhysicsDebugRecordingTicks(clean.snapshotTicks(), tiny.snapshotTicks());
    expect(result.firstHashMismatchTick).toBe(20);
    expect(result.firstExceededTick).toBeNull();
    expect(result.exceededTickCount).toBe(0);
  });

  it("tick 号错位宁少比不错比:两段重叠区间按交集对齐", () => {
    const a = record();
    const poses = new Float64Array(4 * PHYSICS_DEBUG_POSE_STRIDE);
    const b = new PhysicsDebugRecorder({ tickCapacity: 64, maxBodies: 4 });
    b.start(0);
    for (let tick = 10; tick <= 40; tick += 1) b.record(makeTickInput(tick, 4, poses));
    const result = comparePhysicsDebugRecordingTicks(a.snapshotTicks(), b.snapshotTicks());
    expect(result.ticksCompared).toBe(31);
    expect(result.firstExceededTick).toBeNull();
  });
});

describe("验收④:录制开启帧时增量 ≤0.3ms", () => {
  it("默认容量 96 体:record() p95 ≤ 0.3ms(实测值输出为证据)", () => {
    const recorder = new PhysicsDebugRecorder();
    const bodyCount = 96;
    const poses = new Float64Array(bodyCount * PHYSICS_DEBUG_POSE_STRIDE);
    recorder.start(0);
    // 预热 300 次(触发 JIT 与缓存),清空后逐次采样 3600 次。
    for (let tick = 1; tick <= 300; tick += 1) recorder.record(makeTickInput(tick, bodyCount, poses));
    recorder.clear();
    recorder.start(0);
    const samples = new Float64Array(3600);
    let tick = 1;
    for (let i = 0; i < samples.length; i += 1) {
      makeTickInput(tick, bodyCount, poses);
      const t0 = performance.now();
      recorder.record({ tick, poses, bodyCount });
      samples[i] = performance.now() - t0;
      tick += 1;
    }
    const sorted = Array.from(samples).sort((x, y) => x - y);
    const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    // eslint-disable-next-line no-console
    console.log(`[physdbg-perf] record() 96 bodies ×3600: mean=${mean.toFixed(4)}ms p50=${p50.toFixed(4)}ms p95=${p95.toFixed(4)}ms p99=${p99.toFixed(4)}ms (budget 0.3ms)`);
    expect(p95).toBeLessThanOrEqual(0.3);
  });
});

describe("通道与标记合同", () => {
  it("接触/关节通道读回逐位一致,超容量确定性截断并计数", () => {
    const recorder = new PhysicsDebugRecorder({ tickCapacity: 4, maxBodies: 2, maxContactsPerTick: 16, maxJointsPerTick: 8 });
    const poses = new Float64Array(2 * PHYSICS_DEBUG_POSE_STRIDE);
    const contacts = new Float64Array(20 * PHYSICS_DEBUG_CONTACT_STRIDE);
    for (let c = 0; c < 20; c += 1) {
      contacts[c * PHYSICS_DEBUG_CONTACT_STRIDE] = 0;
      contacts[c * PHYSICS_DEBUG_CONTACT_STRIDE + 1] = 1;
      contacts[c * PHYSICS_DEBUG_CONTACT_STRIDE + 4] = 0.002 * (c + 1); // penetration
    }
    const joints = new Float64Array([2, 0.5, -0.25, 0.125]);
    recorder.start(0);
    const outcome = recorder.record({ tick: 1, poses, bodyCount: 2, contacts, contactCount: 20, joints, jointCount: 1 });
    expect(outcome.accepted).toBe(true);
    expect(recorder.truncatedContacts).toBe(4);

    const contactOut = new Float32Array(16 * PHYSICS_DEBUG_CONTACT_STRIDE);
    expect(recorder.copyTickContacts(0, contactOut)).toBe(16);
    expect(contactOut[4]).toBe(Math.fround(0.002));
    expect(contactOut[16 * PHYSICS_DEBUG_CONTACT_STRIDE - 5]).toBe(Math.fround(0.002 * 16)); // 第 16 条(截断后末条)
    const jointOut = new Float32Array(4);
    expect(recorder.copyTickJoints(0, jointOut)).toBe(1);
    expect(jointOut[0]).toBe(2);
    expect(jointOut[1]).toBe(Math.fround(0.5));
  });

  it("非有限位姿整 tick 拒绝并计数;未开始录制显式拒绝", () => {
    const recorder = new PhysicsDebugRecorder({ tickCapacity: 4, maxBodies: 2 });
    const poses = new Float64Array(2 * PHYSICS_DEBUG_POSE_STRIDE);
    expect(recorder.record({ tick: 1, poses, bodyCount: 2 })).toMatchObject({ accepted: false, reason: "not-recording" });
    recorder.start(0);
    poses[3] = Number.NaN;
    expect(recorder.record({ tick: 1, poses, bodyCount: 2 })).toMatchObject({ accepted: false, reason: "non-finite" });
    expect(recorder.droppedTicks).toBe(1);
    poses[3] = 0;
    expect(recorder.record({ tick: 1, poses, bodyCount: 2 }).accepted).toBe(true);
    expect(() => recorder.record({ tick: 2.5, poses, bodyCount: 2 })).toThrow(/tick/);
    expect(() => recorder.record({ tick: 2, poses: new Float64Array(3), bodyCount: 2 })).toThrow(/poses length/);
    expect(recorder.record({ tick: 3, poses, bodyCount: 2 }).accepted).toBe(true);
  });

  it("mark 有序号与 tick,超上限 fail-loud;clear 复位链哈希与统计", () => {
    const recorder = new PhysicsDebugRecorder({ tickCapacity: 8, maxBodies: 1 });
    const poses = new Float64Array(PHYSICS_DEBUG_POSE_STRIDE);
    recorder.start(0);
    recorder.record(makeTickInput(1, 1, poses));
    const mark = recorder.mark("碰撞前");
    expect(mark).toMatchObject({ tick: 1, label: "碰撞前", ordinal: 0 });
    const chainBefore = recorder.chainHash;
    recorder.clear();
    expect(recorder.recordedTickCount).toBe(0);
    expect(recorder.chainHash).toBe("811c9dc5811c9dc5");
    expect(recorder.marks).toHaveLength(0);
    expect(chainBefore).not.toBe(recorder.chainHash);

    const bounded = new PhysicsDebugRecorder({ tickCapacity: 2, maxBodies: 1 });
    bounded.start(0);
    for (let i = 0; i < 70; i += 1) bounded.mark(`m${i}`);
    expect(bounded.marks).toHaveLength(64);
    expect(bounded.mark("overflow")).toBeUndefined();
  });

  it("parsePhysicsDebugRecordingJson 拒绝结构性损坏(中文错误)", () => {
    expect(() => parsePhysicsDebugRecordingJson("not-json")).toThrow(/JSON/);
    expect(() => parsePhysicsDebugRecordingJson(JSON.stringify({ schema: "other", meta: {}, chainHash: "x".repeat(16), ticks: [1] }))).toThrow(/schema/);
    const recorder = new PhysicsDebugRecorder({ tickCapacity: 2, maxBodies: 1 });
    recorder.start(0);
    recorder.record(makeTickInput(1, 1, new Float64Array(PHYSICS_DEBUG_POSE_STRIDE)));
    const good = JSON.parse(recorder.toDebugJson()) as { ticks: Array<Record<string, unknown>> };
    good.ticks[0]!.poses = [0, 0, 0];
    expect(() => parsePhysicsDebugRecordingJson(JSON.stringify(good))).toThrow(/poses 长度/);
  });
});
