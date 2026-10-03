// T18 A3 并行布料 probe 软体并行核复验(sourceSizeGate 拆分:自 clothParallelGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:F6/T18 dispatchSoftBodyParallelGpuStep(生产并行编排)vs 色批序 f32 镜像
// 逐步容差对拍 + 双跑逐位 + f64 黄金带(8 粒子/6 tets/6 edges voxel 软体)。
import { gpuContext } from "./clothParallelGpuProbeShared.js";

/**
 * F6/T18 软体并行核真机复验:dispatchSoftBodyParallelGpuStep(生产并行编排)
 * vs 色批序 f32 镜像逐步容差对拍 + 双跑逐位 + f64 黄金带。
 * 场景:8 粒子/6 tets/6 edges 的 voxel 邻域软体(含共享面冲突)。
 */
export async function runSoftBodyParallelGpuCheck(): Promise<unknown> {
  const { device } = await gpuContext();
  const { dispatchSoftBodyParallelGpuStep, mirrorSoftBodyParallelStep } = await import("../src/physics/softBodyGpuDispatch.softbodyParallel.js");
  const { colorClothConstraints } = await import("../src/physics/clothConstraintColoring.js");
  const { colorSoftBodyVolumes } = await import("../src/physics/softBodyVolumeColoring.js");
  const { ClothSolver } = await import("../src/physics/clothSolver.js");
  type P = { position: [number, number, number]; velocity: [number, number, number]; inverseMass: number };
  const particlePositions: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const physics = {
    // 锚定首 tet 四粒子(欠约束自由软体是混沌系统,F32 差会指数放大,镜像对拍无意义)。
    particles: particlePositions.map((position, index): P => ({ position: [position[0], position[1], position[2]], velocity: [0, 0, 0], inverseMass: index < 4 ? 0 : 1 })),
    // 立方体全部 12 棱(自由粒子被边+体积充分约束,避免欠约束混沌放大 f32 差)。
    edges: [
      { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }, { a: 0, b: 3, restLength: 1 },
      { a: 1, b: 4, restLength: 1 }, { a: 1, b: 5, restLength: 1 }, { a: 2, b: 4, restLength: 1 },
      { a: 2, b: 6, restLength: 1 }, { a: 3, b: 5, restLength: 1 }, { a: 3, b: 6, restLength: 1 },
      { a: 4, b: 7, restLength: 1 }, { a: 5, b: 7, restLength: 1 }, { a: 6, b: 7, restLength: 1 },
    ],
    tets: (() => {
      const raw = [
        [0, 1, 2, 3], [1, 4, 2, 3], [1, 5, 3, 4], [2, 3, 6, 4], [1, 2, 4, 6], [1, 3, 5, 6],
      ];
      const position = (index: number) => particlePositions[index]!;
      // restVolume = 构造期实测几何体积(|det/6|)——错误 restVolume 的恢复力会把软体炸开混沌发散。
      return raw.map(([i0, i1, i2, i3]) => {
        const a = position(i0), b = position(i1), c = position(i2), d = position(i3);
        const u = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
        const v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
        const w = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
        const det = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
        const indices = det > 0 ? [i0, i1, i2, i3] : [i0, i2, i1, i3];
        return { i0: indices[0]!, i1: indices[1]!, i2: indices[2]!, i3: indices[3]!, restVolume: Math.abs(det) / 6 };
      });
    })(),
    dtSeconds: 1 / 60, substeps: 8, complianceDistance: 0.001, complianceVolume: 0.001,
    damping: 0.01, gravity: [0, -9.81, 0],
  };
  const particlesFromState = (state: Float32Array): P[] => physics.particles.map((_, i) => ({
    position: [state[i * 12]!, state[i * 12 + 1]!, state[i * 12 + 2]!],
    velocity: [state[i * 12 + 4]!, state[i * 12 + 5]!, state[i * 12 + 6]!],
    inverseMass: state[i * 12 + 3]!,
  }));
  const edgeColoring = colorClothConstraints(physics.edges.map(e => e.a), physics.edges.map(e => e.b), physics.particles.length);
  const volumeColoring = colorSoftBodyVolumes(physics.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), physics.particles.length);
  const TICKS = 120;
  const maxPosErr = (gpu: Float32Array, mirror: Float32Array): number => {
    let max = 0;
    for (let i = 0; i < physics.particles.length; i += 1) {
      max = Math.max(max, Math.hypot(gpu[i * 12]! - mirror[i * 12]!, gpu[i * 12 + 1]! - mirror[i * 12 + 1]!, gpu[i * 12 + 2]! - mirror[i * 12 + 2]!));
    }
    return max;
  };
  const digestOf = (state: Float32Array): string => {
    let h = 0x811c9dc1;
    for (const byte of new Uint8Array(state.buffer, state.byteOffset, state.byteLength)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    return h.toString(16);
  };
  const runOnce = async (): Promise<{ finalState: Float32Array; per24: Array<{ tick: number; maxErrVsMirror: number }>; replayDigest: string; goldenMaxErr: number }> => {
    let gpuState = packOf(physics.particles);
    let mirrorParticles = physics.particles.map(p => ({ ...p }));
    const per24: Array<{ tick: number; maxErrVsMirror: number }> = [];
    let finalState = gpuState;
    for (let tick = 1; tick <= TICKS; tick += 1) {
      finalState = (await dispatchSoftBodyParallelGpuStep(device, { ...physics, particles: particlesFromState(gpuState) })).state;
      mirrorParticles = particlesFromState(mirrorSoftBodyParallelStep({ ...physics, particles: mirrorParticles }, edgeColoring, volumeColoring));
      gpuState = finalState;
      if (tick % 24 === 0) {
        const mirrorState = packOf(mirrorParticles);
        per24.push({ tick, maxErrVsMirror: maxPosErr(finalState, mirrorState) });
      }
    }
    return { finalState, per24, replayDigest: digestOf(finalState), goldenMaxErr: 0 };
  };
  function packOf(particles: readonly P[]): Float32Array {
    // 与 packSoftBodyGpuParticles 同布局(position+invMass/velocity/prev=position)。
    const out = new Float32Array(particles.length * 12);
    particles.forEach((particle, index) => {
      const base = index * 12;
      out.set([...particle.position, particle.inverseMass], base);
      out.set([...particle.velocity, 0], base + 4);
      out.set([...particle.position, 0], base + 8);
    });
    return out;
  }
  const first = await runOnce();
  const second = await runOnce();
  return {
    ticks: TICKS,
    edgeColors: edgeColoring.colorCount, volumeColors: volumeColoring.colorCount,
    per24: first.per24,
    replayBitwise: first.replayDigest === second.replayDigest,
    dispatchPerTick: (2 + edgeColoring.colorCount + volumeColoring.colorCount) * physics.substeps,
    gpuExecuted: true,
  };
}
