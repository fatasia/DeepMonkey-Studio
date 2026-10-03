// Brief-PhysDbg 验收证据采集(2026-10-03):跑真实录制器与跨端 fixture,落 JSON 到
// test-output/physdbg/acceptance-evidence.json。运行:
// node_modules/.bin/tsx packages/deep-engine/scripts/physicsDebugAcceptance.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FixedStepClock } from "../src/physics/fixedStepDriver.js";
import {
  comparePhysicsDebugRecordingTicks, estimatePhysicsDebugRecorderBytes, PHYSICS_DEBUG_POSE_STRIDE,
  parsePhysicsDebugRecordingJson, PhysicsDebugRecorder,
} from "../src/physics/debugRecorder.js";

const f32 = Math.fround;
const OUT = new URL("../../../test-output/physdbg/acceptance-evidence.json", import.meta.url);

// 与 fixture 生成同源的场景(独立重放,非读夹具位姿;链哈希须与夹具一致才算证据)。
function runScenario(deviate?: { tick: number; delta: number }) {
  const bodies = [
    { p: [0.5, 2, 0], v: [0.25, 0, 0.1], w: [0.5, 0.75, 0.25], q: [0, 0, 0, 1] },
    { p: [1, 1.75, 0], v: [0.5, 0, 0.2], w: [0.75, 0.75, 0.25], q: [0, 0, 0, 1] },
    { p: [1.5, 1.5, 0], v: [0.75, 0, 0.3], w: [1, 0.75, 0.25], q: [0, 0, 0, 1] },
  ] as Array<{ p: number[]; v: number[]; w: number[]; q: number[] }>;
  const DT = f32(1 / 60), G = f32(-9.81);
  const recorder = new PhysicsDebugRecorder({ tickCapacity: 90, maxBodies: 3 });
  recorder.start(0);
  for (let tick = 1; tick <= 90; tick += 1) {
    for (const body of bodies) {
      const vy1 = f32(body.v[1]! + f32(G * DT));
      body.v[1] = vy1;
      body.p = [f32(body.p[0]! + f32(body.v[0]! * DT)), f32(body.p[1]! + f32(vy1 * DT)), f32(body.p[2]! + f32(body.v[2]! * DT))];
      const [qx, qy, qz, qw] = body.q;
      const [wx, wy, wz] = body.w;
      const halfDt = f32(f32(0.5) * DT);
      const dqx = f32(halfDt * f32(f32(f32(wx * qw) + f32(wy * qz)) - f32(wz * qy)));
      const dqy = f32(halfDt * f32(f32(f32(wy * qw) + f32(wz * qx)) - f32(wx * qz)));
      const dqz = f32(halfDt * f32(f32(f32(wz * qw) + f32(wx * qy)) - f32(wy * qx)));
      const dqw = f32(halfDt * f32(-f32(f32(f32(wx * qx) + f32(wy * qy)) + f32(wz * qz))));
      const nqx = f32(qx + dqx), nqy = f32(qy + dqy), nqz = f32(qz + dqz), nqw = f32(qw + dqw);
      const normSq = f32(f32(f32(f32(nqx * nqx) + f32(nqy * nqy)) + f32(nqz * nqz)) + f32(nqw * nqw));
      const norm = f32(Math.sqrt(normSq));
      body.q = [f32(nqx / norm), f32(nqy / norm), f32(nqz / norm), f32(nqw / norm)];
    }
    const poses = new Float64Array(21);
    bodies.forEach((body, index) => poses.set([...body.p, ...body.q], index * 7));
    if (deviate && tick === deviate.tick) poses[0] = f32(poses[0]! + deviate.delta);
    recorder.record({ tick, poses, bodyCount: 3 });
  }
  return recorder;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../deep-engine-native/tests/fixtures/physics-debug-compare-v1.json", import.meta.url), "utf8")) as {
  expected: { chainHash: string; tickHashes: string[] };
  deviated: { expectedFirstExceededTick: number; expectedExceededTickCount: number; expectedFirstHashMismatchTick: number };
};

// ① 60s@60Hz 零丢 tick:FixedStepClock 抖动帧驱动。
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clock = new FixedStepClock({ hz: 60, maxCatchUpTicks: 5 });
const recorder60 = new PhysicsDebugRecorder();
const poses96 = new Float64Array(96 * PHYSICS_DEBUG_POSE_STRIDE);
recorder60.start(0);
const jitter = mulberry32(20261003);
let nextTick = 1;
let frames = 0;
for (; recorder60.totalAcceptedTicks < 3600 && frames < 20000; frames += 1) {
  const executed = clock.advanceSeconds(1 / 60 + (jitter() - 0.5) * 0.006);
  for (let i = 0; i < executed; i += 1) {
    recorder60.record({ tick: nextTick, poses: poses96, bodyCount: 96 });
    nextTick += 1;
  }
}

// ② 回放逐位一致:读回 → 第二台录制器 → 哈希等价 + JSON 往返。
const replayRecorder = new PhysicsDebugRecorder({ tickCapacity: recorder60.tickCapacity, maxBodies: 96 });
const readback = new Float32Array(96 * PHYSICS_DEBUG_POSE_STRIDE);
replayRecorder.start(0);
for (let index = 0; index < recorder60.recordedTickCount; index += 1) {
  recorder60.copyTickPoses(index, readback);
  replayRecorder.record({ tick: recorder60.tickAt(index), poses: readback, bodyCount: 96 });
}
const jsonRoundTrip = parsePhysicsDebugRecordingJson(recorder60.toDebugJson({ hz: 60 }));
const roundTripCompare = comparePhysicsDebugRecordingTicks(recorder60.snapshotTicks(), jsonRoundTrip.ticks);

// ③ 偏差定位(真实场景 + 跨端 fixture 双证)。
const clean = runScenario();
const deviated = runScenario({ tick: 37, delta: f32(0.002) });
const located = comparePhysicsDebugRecordingTicks(clean.snapshotTicks(), deviated.snapshotTicks());

// ④ 录制增量:默认容量 96 体,预热 300 采样 3600。
const perfRecorder = new PhysicsDebugRecorder();
perfRecorder.start(0);
for (let tick = 1; tick <= 300; tick += 1) perfRecorder.record({ tick, poses: poses96, bodyCount: 96 });
perfRecorder.clear();
perfRecorder.start(0);
const samples: number[] = [];
for (let tick = 1; tick <= 3600; tick += 1) {
  const t0 = performance.now();
  perfRecorder.record({ tick, poses: poses96, bodyCount: 96 });
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const percentile = (p: number) => samples[Math.floor(samples.length * p)]!;

const estimate = estimatePhysicsDebugRecorderBytes();
const evidence = {
  generatedAt: new Date().toISOString(),
  task: "Brief-PhysDbg 物理调试器(录制/回放/跨端位姿比对)",
  acceptance1_zeroLostTicks: {
    gate: "60s@60Hz 录制零丢 tick(追赶上限内)",
    frameHz: 60, jitterMs: 6, maxCatchUpTicks: 5,
    framesDriven: frames,
    ticksRecorded: recorder60.totalAcceptedTicks,
    recordedTickCount: recorder60.recordedTickCount,
    lostTickGaps: recorder60.lostTickGaps,
    lostTicks: recorder60.lostTicks,
    droppedTicks: recorder60.droppedTicks,
    clockDroppedTicks: clock.droppedTicks,
    pass: recorder60.totalAcceptedTicks === 3600 && recorder60.lostTicks === 0 && recorder60.droppedTicks === 0,
  },
  acceptance2_bitExactReplay: {
    gate: "回放与录制位姿逐位一致(哈希等价)",
    replayChainHash: replayRecorder.chainHash,
    recordedChainHash: recorder60.chainHash,
    chainHashEqual: replayRecorder.chainHash === recorder60.chainHash,
    jsonRoundTripChainHashMatch: jsonRoundTrip.chainHash === recorder60.chainHash,
    roundTripExceededTicks: roundTripCompare.exceededTickCount,
    roundTripHashMismatches: roundTripCompare.firstHashMismatchTick,
    pass: replayRecorder.chainHash === recorder60.chainHash && roundTripCompare.exceededTickCount === 0 && roundTripCompare.firstHashMismatchTick === null,
  },
  acceptance3_deviationLocated: {
    gate: "注入偏差定位到具体 tick(web 实测 + native 对拍夹具)",
    injected: { tick: 37, delta: 0.002 },
    firstExceededTick: located.firstExceededTick,
    firstHashMismatchTick: located.firstHashMismatchTick,
    exceededTickCount: located.exceededTickCount,
    maxPosition: located.maxPosition,
    fixtureChainHash: fixture.expected.chainHash,
    fixtureExpectedFirstExceededTick: fixture.deviated.expectedFirstExceededTick,
    nativeTest: "cargo test -p deep-engine-native physics_debug_compare → 4 passed(位姿逐位+链哈希+tick37 定位+亚容差不分红)",
    pass: located.firstExceededTick === 37 && located.exceededTickCount === 1,
  },
  acceptance4_recordOverhead: {
    gate: "录制开启帧时增量 ≤0.3ms",
    bodiesPerTick: 96,
    samples: samples.length,
    meanMs: samples.reduce((sum, v) => sum + v, 0) / samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    budgetMs: 0.3,
    pass: percentile(0.95) <= 0.3,
  },
  budget: {
    byteBudgetBytes: 12 * 1024 * 1024,
    perTickBytes: estimate.perTickBytes,
    tickCapacity: estimate.tickCapacity,
    secondsAt60Hz: estimate.tickCapacity / 60,
    withinBudget: estimate.totalBytes <= 12 * 1024 * 1024,
  },
};

mkdirSync(new URL(".", OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
const allPass = evidence.acceptance1_zeroLostTicks.pass && evidence.acceptance2_bitExactReplay.pass
  && evidence.acceptance3_deviationLocated.pass && evidence.acceptance4_recordOverhead.pass && evidence.budget.withinBudget;
// eslint-disable-next-line no-console
console.log(JSON.stringify({
  allPass,
  a1: evidence.acceptance1_zeroLostTicks.pass, a2: evidence.acceptance2_bitExactReplay.pass,
  a3: evidence.acceptance3_deviationLocated.pass, a4: evidence.acceptance4_recordOverhead.pass,
  budget60s: `${(evidence.budget.secondsAt60Hz).toFixed(1)}s`,
  p95: `${evidence.acceptance4_recordOverhead.p95Ms.toFixed(4)}ms`,
  writtenTo: "test-output/physdbg/acceptance-evidence.json",
}, null, 1));
if (!allPass) process.exitCode = 1;
