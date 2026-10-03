// 生成共享 fixture:physics-debug-compare-v1.json(Brief-PhysDbg 物理调试器跨端对拍)。
// TS 侧确定性 f32 场景是本合同的生成源;Rust 测试(deep-engine-native/src/physics_debug_compare.rs)
// 用逐运算同构的 f32 镜像重放,与夹具的位姿/逐 tick 哈希/链哈希逐位对拍。
// 运行:node_modules/.bin/tsx packages/deep-engine/scripts/physicsDebugFixtureGen.mts(生成后入库)。
//
// 场景合同(两侧必须逐运算同构,双舍入免疫定理保证 fround(f64 单运算)== f32 单运算):
//   dt = fround(1/60);g = fround(-9.81) 仅作用 y 轴速度;
//   每 tick:v.y += g*dt;p += v*dt(逐轴 f32);
//   四元数:dq = f32(0.5*dt) * (ω⊗q) 分量(乘积式见 STEP 注释),q += dq 后单位化
//   (范数平方按 ((qx²+qy²)+qz²)+qw² 固定序,开方/除法 f32)。
import { mkdirSync, writeFileSync } from "node:fs";
import {
  comparePhysicsDebugRecordingTicks, PHYSICS_DEBUG_POSE_STRIDE, PhysicsDebugRecorder,
} from "../src/physics/debugRecorder.js";

const OUT_PATH = new URL("../../deep-engine-native/tests/fixtures/physics-debug-compare-v1.json", import.meta.url);

const f32 = Math.fround;
const TICKS = 90;
const BODY_COUNT = 3;
const DT = f32(1 / 60);
const G = f32(-9.81);

interface Body {
  p: [number, number, number];
  v: [number, number, number];
  w: [number, number, number];
  q: [number, number, number, number];
}

// 初值全部为 f32 精确可表示值(0.5/0.25/0.75 幂次组合),杜绝初值歧义。
function initialBodies(): Body[] {
  return [
    { p: [f32(0.5), 2, 0], v: [f32(0.25), 0, f32(0.1)], w: [f32(0.5), f32(0.75), f32(0.25)], q: [0, 0, 0, 1] },
    { p: [1, f32(1.75), 0], v: [f32(0.5), 0, f32(0.2)], w: [f32(0.75), f32(0.75), f32(0.25)], q: [0, 0, 0, 1] },
    { p: [f32(1.5), f32(1.5), 0], v: [f32(0.75), 0, f32(0.3)], w: [1, f32(0.75), f32(0.25)], q: [0, 0, 0, 1] },
  ];
}

/** 推进一个固定步;每个二元运算一次 fround(Rust 镜像逐式同构,改动必须两侧同步)。 */
function stepTick(bodies: Body[]): void {
  for (const body of bodies) {
    const [px, py, pz] = body.p;
    const [vx, vy, vz] = body.v;
    const [qx, qy, qz, qw] = body.q;
    const [wx, wy, wz] = body.w;
    // 半隐式欧拉:先速度后位置;y 轴受重力。
    const vy1 = f32(vy + f32(G * DT));
    body.v = [vx, vy1, vz];
    body.p = [f32(px + f32(vx * DT)), f32(py + f32(vy1 * DT)), f32(pz + f32(vz * DT))];
    // 四元数积分:q̇ = 0.5·(ω⊗q);ω⊗q 分量 = (wx·qw + wy·qz − wz·qy, wy·qw + wz·qx − wx·qz, wz·qw + wx·qy − wy·qx, −(wx·qx + wy·qy + wz·qz))。
    const halfDt = f32(f32(0.5) * DT);
    const dqx = f32(halfDt * f32(f32(f32(wx * qw) + f32(wy * qz)) - f32(wz * qy)));
    const dqy = f32(halfDt * f32(f32(f32(wy * qw) + f32(wz * qx)) - f32(wx * qz)));
    const dqz = f32(halfDt * f32(f32(f32(wz * qw) + f32(wx * qy)) - f32(wy * qx)));
    const dqw = f32(halfDt * f32(-f32(f32(f32(wx * qx) + f32(wy * qy)) + f32(wz * qz))));
    const nqx = f32(qx + dqx), nqy = f32(qy + dqy), nqz = f32(qz + dqz), nqw = f32(qw + dqw);
    // 单位化:范数平方固定序 (((qx²+qy²)+qz²)+qw²)。
    const normSq = f32(f32(f32(f32(nqx * nqx) + f32(nqy * nqy)) + f32(nqz * nqz)) + f32(nqw * nqw));
    const norm = f32(Math.sqrt(normSq));
    body.q = [f32(nqx / norm), f32(nqy / norm), f32(nqz / norm), f32(nqw / norm)];
  }
}

function poseBlock(bodies: Body[]): Float64Array {
  const block = new Float64Array(BODY_COUNT * PHYSICS_DEBUG_POSE_STRIDE);
  bodies.forEach((body, index) => {
    block[index * PHYSICS_DEBUG_POSE_STRIDE] = body.p[0]!;
    block[index * PHYSICS_DEBUG_POSE_STRIDE + 1] = body.p[1]!;
    block[index * PHYSICS_DEBUG_POSE_STRIDE + 2] = body.p[2]!;
    block[index * PHYSICS_DEBUG_POSE_STRIDE + 3] = body.q[0]!;
    block[index * PHYSICS_DEBUG_POSE_STRIDE + 4] = body.q[1]!;
    block[index * PHYSICS_DEBUG_POSE_STRIDE + 5] = body.q[2]!;
    block[index * PHYSICS_DEBUG_POSE_STRIDE + 6] = body.q[3]!;
  });
  return block;
}

/** 跑完整场景并经真实 PhysicsDebugRecorder 录制(哈希/链哈希即产品实现,非测试镜像)。 */
function runScenario(deviate?: { tick: number; delta: number }) {
  const bodies = initialBodies();
  const recorder = new PhysicsDebugRecorder({ tickCapacity: TICKS, maxBodies: BODY_COUNT });
  recorder.start(0);
  for (let tick = 1; tick <= TICKS; tick += 1) {
    stepTick(bodies);
    const block = poseBlock(bodies);
    if (deviate && tick === deviate.tick) block[0] = f32(block[0]! + deviate.delta);
    recorder.record({ tick, poses: block, bodyCount: BODY_COUNT });
    if (!deviate && tick === 45) recorder.mark("mid-recording");
  }
  return recorder;
}

const clean = runScenario();
if (clean.recordedTickCount !== TICKS || clean.lostTicks !== 0 || clean.droppedTicks !== 0) {
  throw new Error(`clean run broken: ${clean.recordedTickCount} ticks, lost=${clean.lostTicks}, dropped=${clean.droppedTicks}`);
}
const mark = clean.marks[0];
if (!mark || mark.tick !== 45 || mark.label !== "mid-recording") throw new Error("mark(45) 漂移,fixture 合同失真");
const cleanTicks = clean.snapshotTicks();
if (cleanTicks.some((entry) => entry.bodyCount !== BODY_COUNT)) throw new Error("bodyCount 漂移");

// 偏差注入:tick 37 body 0 px += f32(2e-3)(超 1e-3 容差 2 倍)。
const DEVIATION = { tick: 37, body: 0, delta: f32(0.002) };
const deviated = runScenario(DEVIATION);
const deviatedTicks = deviated.snapshotTicks();
const comparison = comparePhysicsDebugRecordingTicks(cleanTicks, deviatedTicks);
if (comparison.firstExceededTick !== DEVIATION.tick || comparison.exceededTickCount !== 1 || comparison.firstHashMismatchTick !== DEVIATION.tick) {
  throw new Error(`deviation not located: first=${comparison.firstExceededTick} count=${comparison.exceededTickCount} hash=${comparison.firstHashMismatchTick}`);
}

const fixture = {
  schema: "deep-engine.physics-debug-recording-parity",
  schemaVersion: 1,
  note: "Brief-PhysDbg 物理调试器跨端对拍:TS(debugRecorder.ts + physicsDebugFixtureGen.mts)生成;Rust(deep-engine-native/src/physics_debug_compare.rs)逐运算同构 f32 镜像重放。哈希=FNV-1a 双车道(f32 小端,正/反字节序);链哈希=chain=fnv1a(chain⊕tickHash),种子 0x811c9dc5。场景=f32 半隐式欧拉抛物体+四元数自旋,运算序见生成脚本 stepTick 注释,改任何参数必须两侧同步。",
  tolerances: { positionMeters: 1e-3, rotationRadians: 1e-3 },
  scenario: {
    ticks: TICKS,
    bodyCount: BODY_COUNT,
    dtSeconds: DT,
    gravityY: G,
    bodies: initialBodies(),
    poseStride: PHYSICS_DEBUG_POSE_STRIDE,
  },
  expected: {
    chainHash: clean.chainHash,
    marks: clean.marks,
    tickHashes: cleanTicks.map((entry) => entry.hash),
    poses: cleanTicks.map((entry) => Array.from(entry.poses)),
  },
  deviated: {
    ...DEVIATION,
    chainHash: deviated.chainHash,
    tickHashes: deviatedTicks.map((entry) => entry.hash),
    poses: deviatedTicks.map((entry) => Array.from(entry.poses)),
    expectedFirstExceededTick: comparison.firstExceededTick,
    expectedExceededTickCount: comparison.exceededTickCount,
    expectedFirstHashMismatchTick: comparison.firstHashMismatchTick,
    expectedMaxPosition: comparison.maxPosition,
  },
};

mkdirSync(new URL(".", OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(fixture, null, 1)}\n`, "utf8");
// eslint-disable-next-line no-console
console.log(`physics-debug-compare-v1.json written: ticks=${TICKS} chain=${clean.chainHash} deviated@${DEVIATION.tick} firstExceeded=${comparison.firstExceededTick} maxPos=${comparison.maxPosition.toExponential(3)}`);
