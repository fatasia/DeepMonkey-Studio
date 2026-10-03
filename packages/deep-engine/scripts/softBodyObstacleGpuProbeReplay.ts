// F6/T18 软体并行核障碍刀 B/C/D 列:动力学场景(sourceSizeGate 拆分:自
// softBodyObstacleGpuProbe.ts 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:Kuhn 6-tet 软体夹具、120 tick GPU 重放(有/无障碍)+ 镜像对拍 + 黄金对照 + 接触可观测。
// Kuhn 6-tet 分解(全 8 顶点,各体积 1/6,绕 p0→p7 体对角线);边集与 SoftBodySolver
// 黄金同源(tet 全对去重,rest=初始距离)。球摆在黄金静息 p7=(1.0156,0.9601,1.0156)
// 正下方(center = sag−(0,0.34,0)),只承接 p7(p4/p5/p6 距球心 ≥0.60)。
import type { SoftBodyGpuParticleInput, SoftBodyGpuStepInput } from "../src/physics/softBodyGpuWgsl.js";
import { colorClothConstraints } from "../src/physics/clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "../src/physics/softBodyVolumeColoring.js";
import { createSoftBodyStaticCollision } from "../src/physics/softBodyStaticCollision.js";
import { SoftBodySolver } from "../src/physics/softBodySolver.js";
import { packSoftBodyGpuParticles, type SoftBodyGpuObstacle } from "../src/physics/softBodyGpuWgsl.js";
import { dispatchSoftBodyParallelGpuStep } from "../src/physics/softBodyGpuDispatch.softbodyParallel.js";
import { mirrorSoftBodyParallelStep } from "../src/physics/softBodyParallelMirror.js";
import { gpuContext, rotationFromQuaternion, fixedBody } from "./softBodyObstacleGpuProbeShared.js";

const KUHN_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const KUHN_TETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 4, 1, 7], [0, 2, 4, 7], [0, 6, 2, 7], [0, 3, 6, 7], [0, 5, 3, 7], [0, 1, 5, 7],
];
const SPHERE_CENTER: readonly [number, number, number] = [1.016, 0.619, 1.016];
const SPHERE_RADIUS = 0.35;
const SPHERE: SoftBodyGpuObstacle = { center: SPHERE_CENTER, radius: SPHERE_RADIUS,
  rotation: rotationFromQuaternion([0, 0, 0, 1]), halfExtents: [0, 0, 0] };

function kuhnEdges(): Array<{ a: number; b: number; restLength: number }> {
  const seen = new Set<number>();
  const edges: Array<{ a: number; b: number; restLength: number }> = [];
  for (const tet of KUHN_TETS) {
    for (let a = 0; a < 4; a += 1) {
      for (let b = a + 1; b < 4; b += 1) {
        const lo = Math.min(tet[a]!, tet[b]!); const hi = Math.max(tet[a]!, tet[b]!);
        if (seen.has(lo * 8 + hi)) continue;
        seen.add(lo * 8 + hi);
        edges.push({ a: lo, b: hi, restLength: Math.hypot(
          KUHN_POSITIONS[lo]![0]! - KUHN_POSITIONS[hi]![0]!,
          KUHN_POSITIONS[lo]![1]! - KUHN_POSITIONS[hi]![1]!,
          KUHN_POSITIONS[lo]![2]! - KUHN_POSITIONS[hi]![2]!) });
      }
    }
  }
  return edges;
}

function kuhnRestVolume(tet: readonly [number, number, number, number]): number {
  const at = (index: number) => KUHN_POSITIONS[index]!;
  const a = at(tet[0]); const b = at(tet[1]); const c = at(tet[2]); const d = at(tet[3]);
  const u = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
  const v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
  const w = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
  const volume = (u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!)) / 6;
  if (volume <= 0) throw new Error("GPU oracle fixture winding must match the CPU normalized positive volume");
  return volume;
}

const KUHN_PHYSICS: SoftBodyGpuStepInput = {
  particles: KUHN_POSITIONS.map((position, index): SoftBodyGpuParticleInput => ({
    position: [position[0], position[1], position[2]], velocity: [0, 0, 0], inverseMass: index < 4 ? 0 : 1,
  })),
  edges: kuhnEdges(),
  tets: KUHN_TETS.map(tet => ({ i0: tet[0], i1: tet[1], i2: tet[2], i3: tet[3], restVolume: kuhnRestVolume(tet) })),
  dtSeconds: 1 / 60, substeps: 8, complianceDistance: 0.001, complianceVolume: 0.001,
  damping: 0.01, gravity: [0, -9.81, 0],
};

const fromState = (state: Float32Array): SoftBodyGpuParticleInput[] =>
  KUHN_PHYSICS.particles.map((_, i) => ({
    position: [state[i * 12]!, state[i * 12 + 1]!, state[i * 12 + 2]!],
    velocity: [state[i * 12 + 4]!, state[i * 12 + 5]!, state[i * 12 + 6]!],
    inverseMass: state[i * 12 + 3]!,
  }));

const maxPosErr = (a: Float32Array, b: Float32Array): number => {
  let max = 0;
  for (let i = 0; i < 8; i += 1) {
    max = Math.max(max, Math.hypot(a[i * 12]! - b[i * 12]!, a[i * 12 + 1]! - b[i * 12 + 1]!, a[i * 12 + 2]! - b[i * 12 + 2]!));
  }
  return max;
};

const digestOf = (state: Float32Array): string => {
  let h = 0x811c9dc1;
  for (const byte of new Uint8Array(state.buffer, state.byteOffset, state.byteLength)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16);
};

const minFreeSurfaceGap = (state: Float32Array): number => {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 4; i < 8; i += 1) {
    min = Math.min(min, Math.abs(Math.hypot(
      state[i * 12]! - SPHERE_CENTER[0], state[i * 12 + 1]! - SPHERE_CENTER[1], state[i * 12 + 2]! - SPHERE_CENTER[2]) - SPHERE_RADIUS));
  }
  return min;
};

/** B/C/D 列:120 tick GPU 重放(有/无障碍)+ 镜像对拍 + 黄金对照 + 接触可观测。 */
export async function runSoftBodyObstacleGpuReplay(): Promise<unknown> {
  const { device } = await gpuContext();
  const edgeColoring = colorClothConstraints(KUHN_PHYSICS.edges.map(e => e.a), KUHN_PHYSICS.edges.map(e => e.b), 8);
  const volumeColoring = colorSoftBodyVolumes(KUHN_PHYSICS.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), 8);
  const withObstacles: SoftBodyGpuStepInput = { ...KUHN_PHYSICS, obstacles: [SPHERE] };

  const TICKS = 120;
  const runGpu = async (input: SoftBodyGpuStepInput) => {
    let gpuState = packSoftBodyGpuParticles(input.particles);
    let mirrorParticles = input.particles.map(p => ({ ...p }));
    const checkpoints = new Map<number, Float32Array>();
    const per24: Array<{ tick: number; maxErrVsMirror: number; minSurfaceGap: number }> = [];
    for (let tick = 1; tick <= TICKS; tick += 1) {
      gpuState = (await dispatchSoftBodyParallelGpuStep(device, { ...input, particles: fromState(gpuState) })).state;
      mirrorParticles = fromState(mirrorSoftBodyParallelStep({ ...input, particles: mirrorParticles }, edgeColoring, volumeColoring));
      if (tick % 24 === 0) {
        checkpoints.set(tick, gpuState.slice());
        per24.push({
          tick,
          maxErrVsMirror: maxPosErr(gpuState, packSoftBodyGpuParticles(mirrorParticles)),
          minSurfaceGap: minFreeSurfaceGap(gpuState),
        });
      }
    }
    return { finalState: gpuState, per24, checkpoints, digest: digestOf(gpuState) };
  };

  const withObs = await runGpu(withObstacles);
  const withObsRepeat = await runGpu(withObstacles);
  const withoutObs = await runGpu(KUHN_PHYSICS);

  // f64 黄金:SoftBodySolver(contacts 每子步两次)± 球;对照列同构。
  const golden = (withContacts: boolean) => new SoftBodySolver({
    positions: KUHN_POSITIONS, tets: KUHN_TETS.map(tet => [tet[0], tet[1], tet[2], tet[3]] as [number, number, number, number]),
    mass: 1, pinned: [0, 1, 2, 3],
    gravity: [0, -9.81, 0], dtSeconds: KUHN_PHYSICS.dtSeconds, substeps: KUHN_PHYSICS.substeps,
    complianceDistance: KUHN_PHYSICS.complianceDistance, complianceVolume: KUHN_PHYSICS.complianceVolume,
    damping: KUHN_PHYSICS.damping,
    contacts: withContacts ? createSoftBodyStaticCollision(
      [fixedBody("sphere", SPHERE_CENTER, [0, 0, 0, 1], { shape: "sphere", radius: SPHERE_RADIUS })], ["sphere"]) : undefined,
  });
  const goldenWith = golden(true);
  const goldenWithout = golden(false);
  const goldenWithPer24: Array<{ tick: number; maxErr: number }> = [];
  const goldenWithoutPer24: Array<{ tick: number; maxErr: number }> = [];
  for (let tick = 1; tick <= TICKS; tick += 1) {
    goldenWith.step(); goldenWithout.step();
    if (tick % 24 === 0) {
      const gw = goldenWith.capture(); const go = goldenWithout.capture();
      goldenWithPer24.push({ tick, maxErr: maxPosErr(withObs.checkpoints.get(tick)!, packToCompare(gw)) });
      goldenWithoutPer24.push({ tick, maxErr: maxPosErr(withoutObs.checkpoints.get(tick)!, packToCompare(go)) });
    }
  }
  function packToCompare(snap: { px: Float64Array; py: Float64Array; pz: Float64Array }): Float32Array {
    const out = new Float32Array(8 * 12);
    for (let i = 0; i < 8; i += 1) {
      out[i * 12] = Math.fround(snap.px[i]!); out[i * 12 + 1] = Math.fround(snap.py[i]!); out[i * 12 + 2] = Math.fround(snap.pz[i]!);
    }
    return out;
  }
  const extraDivergence = goldenWithPer24.map((row, index) => ({
    tick: row.tick,
    withObstacles: row.maxErr,
    withoutObstacles: goldenWithoutPer24[index]!.maxErr,
    extra: row.maxErr - goldenWithoutPer24[index]!.maxErr,
  }));
  const minGap = Math.min(...withObs.per24.map(row => row.minSurfaceGap));
  const goldenSnap = goldenWith.capture();
  const goldenMinGap = Math.min(...Array.from({ length: 4 }, (_, k) =>
    Math.abs(Math.hypot(goldenSnap.px[k + 4]! - SPHERE_CENTER[0], goldenSnap.py[k + 4]! - SPHERE_CENTER[1], goldenSnap.pz[k + 4]! - SPHERE_CENTER[2]) - SPHERE_RADIUS)));

  return {
    ticks: TICKS, substeps: KUHN_PHYSICS.substeps,
    edgeCount: KUHN_PHYSICS.edges.length, tetCount: KUHN_PHYSICS.tets.length,
    edgeColors: edgeColoring.colorCount, volumeColors: volumeColoring.colorCount,
    dispatchPerTick: (2 + edgeColoring.colorCount + volumeColoring.colorCount + 2) * KUHN_PHYSICS.substeps,
    // B:内核合同(镜像同编排,容差承担 f32;双跑逐位):
    per24: withObs.per24,
    mirrorTolerance: 0.05,
    mirrorWithinTolerance: withObs.per24.every(row => row.maxErrVsMirror <= 0.05),
    replayBitwise: withObs.digest === withObsRepeat.digest,
    // C:黄金对照列(如实边界:并行色批序 vs 串行构建序在软 compliance 过约束系统上
    // 有投影序相关平衡态差异,无障碍对照列同时量化;extra = 障碍核边际效应):
    goldenColumns: { withObstacles: goldenWithPer24, withoutObstacles: goldenWithoutPer24, extraDivergence },
    maxExtraDivergence: Math.max(...extraDivergence.map(row => Math.abs(row.extra))),
    // D:接触可观测:
    contactObserved: minGap < 0.05, minSurfaceGap: minGap, contactThreshold: 0.05,
    goldenMinSurfaceGap: goldenMinGap,
    gpuExecuted: true,
  };
}
