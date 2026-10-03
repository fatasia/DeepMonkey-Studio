// F6/T18 风场刀:真机 WebGPU 探针(浏览器内执行,由 softBodyWindCollisionGpuTest.mjs 打包驱动)。
// [软体·主交付] 体素软体(8/12/6,tet 构造期环绕规整)+风+球障碍同场景:W1 风生效
// (digest 不同+位移风向投影>0)、W2 GPU vs 色批序 f32 镜像逐 24 tick ≤0.05、
// W3 双跑逐位、W4 接触可观测(min|dist−r|<0.05)、W5 零风+障碍退化列。
// [布料·组合缺口补齐] 旗布+风+球:GPU(dispatchClothStepAuto) vs f64 黄金(ClothSolver
// wind+contacts 同式球面)三列归因矩阵;kernel=cloth-parallel 无回退。
// uncapturederror 常驻监听(softbody-divergence-20261002 教训:绑定违约静默丢弃只有
// 此通道可见);digest 演进断言(读回冻结全零=静默失效即 fail)。
import { colorClothConstraints } from "../src/physics/clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "../src/physics/softBodyVolumeColoring.js";
import { ClothSolver } from "../src/physics/clothSolver.js";
import { buildClothParallelState } from "../src/physics/clothParallelSolver.js";
import { dispatchClothStepAuto } from "../src/physics/softBodyGpuDispatch.clothParallel.js";
import { dispatchSoftBodyParallelGpuStep } from "../src/physics/softBodyGpuDispatch.softbodyParallel.js";
import { mirrorSoftBodyParallelStep } from "../src/physics/softBodyParallelMirror.js";
import { packSoftBodyGpuParticles, type SoftBodyGpuObstacle, type SoftBodyGpuParticleInput,
  type SoftBodyGpuStepInput } from "../src/physics/softBodyGpuWgsl.js";

export const gpuUncapturedErrors: string[] = [];

export async function probeAdapterInfo(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
}

async function gpuContext(): Promise<GPUDevice> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  device.addEventListener("uncapturederror", (event) => {
    const message = (event as GPUUncapturedErrorEvent).error?.message ?? String(event);
    if (gpuUncapturedErrors.length < 32) gpuUncapturedErrors.push(message.slice(0, 300));
  });
  return device;
}

// —— 体素软体夹具(与障碍刀/风 CPU 测试同源;tet 环绕构造期规整,restVolume=实测正体积) ——
const VOXEL_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const SPHERE: SoftBodyGpuObstacle = { center: [1.5, 1, 1], radius: 0.5,
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], halfExtents: [0, 0, 0] };
const WIND = { direction: [0.6, 0, 0.2] as const, baseSpeed: 1.2, gustFrequency: 0.9, spatialScale: 2.5, seed: 7 };

function voxelInput(): SoftBodyGpuStepInput {
  return {
    particles: VOXEL_POSITIONS.map((position, index): SoftBodyGpuParticleInput => ({
      position: [position[0], position[1], position[2]], velocity: [0, 0, 0], inverseMass: index < 4 ? 0 : 1,
    })),
    edges: [
      { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }, { a: 0, b: 3, restLength: 1 },
      { a: 1, b: 4, restLength: 1 }, { a: 1, b: 5, restLength: 1 }, { a: 2, b: 4, restLength: 1 },
      { a: 2, b: 6, restLength: 1 }, { a: 3, b: 5, restLength: 1 }, { a: 3, b: 6, restLength: 1 },
      { a: 4, b: 7, restLength: 1 }, { a: 5, b: 7, restLength: 1 }, { a: 6, b: 7, restLength: 1 },
    ],
    tets: (() => {
      const raw = [[0, 1, 2, 3], [1, 4, 2, 3], [1, 5, 3, 4], [2, 3, 6, 4], [1, 2, 4, 6], [1, 3, 5, 6]];
      const at = (index: number) => VOXEL_POSITIONS[index]!;
      return raw.map(([i0, i1, i2, i3]) => {
        const a = at(i0), b = at(i1), c = at(i2), d = at(i3);
        const u = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
        const v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
        const w = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
        const det = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
        const indices = det > 0 ? [i0, i1, i2, i3] : [i0, i2, i1, i3];
        return { i0: indices[0]!, i1: indices[1]!, i2: indices[2]!, i3: indices[3]!, restVolume: Math.abs(det) / 6 };
      });
    })(),
    dtSeconds: 1 / 60, substeps: 8, complianceDistance: 0.001, complianceVolume: 0.001,
    damping: 0.01, gravity: [0, -9.81, 0],
  };
}

const digestOf = (state: Float32Array): string => {
  let h = 0x811c9dc1;
  for (const byte of new Uint8Array(state.buffer, state.byteOffset, state.byteLength)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16);
};
const maxPosErr = (a: Float32Array, b: Float32Array, count: number): number => {
  let max = 0;
  for (let i = 0; i < count; i += 1) {
    max = Math.max(max, Math.hypot(a[i * 12]! - b[i * 12]!, a[i * 12 + 1]! - b[i * 12 + 1]!, a[i * 12 + 2]! - b[i * 12 + 2]!));
  }
  return max;
};
const minSurfaceGap = (state: Float32Array): number => {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 4; i < 8; i += 1) {
    min = Math.min(min, Math.abs(Math.hypot(
      state[i * 12]! - SPHERE.center[0], state[i * 12 + 1]! - SPHERE.center[1], state[i * 12 + 2]! - SPHERE.center[2]) - SPHERE.radius));
  }
  return min;
};

/** [软体] 风×障碍组合主列 + 零风退化列 + 双跑逐位 + 风生效 + 接触可观测。 */
export async function runSoftBodyWindCollisionCheck(): Promise<unknown> {
  const device = await gpuContext();
  const physics = voxelInput();
  const count = physics.particles.length;
  const edgeColoring = colorClothConstraints(physics.edges.map(e => e.a), physics.edges.map(e => e.b), count);
  const volumeColoring = colorSoftBodyVolumes(physics.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), count);
  const TICKS = 120;
  const fromState = (state: Float32Array): SoftBodyGpuParticleInput[] =>
    physics.particles.map((_, i) => ({
      position: [state[i * 12]!, state[i * 12 + 1]!, state[i * 12 + 2]!],
      velocity: [state[i * 12 + 4]!, state[i * 12 + 5]!, state[i * 12 + 6]!],
      inverseMass: state[i * 12 + 3]!,
    }));
  const runGpuAndMirror = async (wind: typeof WIND | undefined) => {
    let gpuState = packSoftBodyGpuParticles(physics.particles);
    let mirrorParticles = physics.particles.map(p => ({ ...p }));
    const per24: Array<{ tick: number; maxErrVsMirror: number; minSurfaceGap: number }> = [];
    let minGap = Number.POSITIVE_INFINITY;
    let digestPrev = "";
    let digestEvolved = true;
    for (let tick = 1; tick <= TICKS; tick += 1) {
      const input: SoftBodyGpuStepInput = {
        ...physics, particles: fromState(gpuState),
        ...(wind ? { wind: { ...wind, tickSeconds: (tick - 1) * physics.dtSeconds } } : {}),
        obstacles: [SPHERE],
      };
      gpuState = (await dispatchSoftBodyParallelGpuStep(device, input)).state;
      mirrorParticles = fromState(mirrorSoftBodyParallelStep({ ...physics, particles: mirrorParticles, wind: wind ? { ...wind, tickSeconds: (tick - 1) * physics.dtSeconds } : undefined, obstacles: [SPHERE] }, edgeColoring, volumeColoring));
      const digest = digestOf(gpuState);
      if (tick === 2) digestEvolved = digest !== digestPrev;
      digestPrev = digest;
      const gap = minSurfaceGap(gpuState);
      minGap = Math.min(minGap, gap);
      if (tick % 24 === 0) per24.push({ tick, maxErrVsMirror: maxPosErr(gpuState, packSoftBodyGpuParticles(mirrorParticles), count), minSurfaceGap: gap });
    }
    return { finalState: gpuState, per24, minGap, digest: digestPrev, digestEvolved };
  };

  const combo = await runGpuAndMirror(WIND);
  const comboRepeat = await runGpuAndMirror(WIND);
  const noWind = await runGpuAndMirror(undefined);
  // W1 风生效:组合 vs 零风障碍列终态不同,且自由角落粒子位移在风方向投影为正。
  let directionDot = 0;
  for (let i = 4; i < 8; i += 1) {
    for (const axis of [0, 1, 2] as const) {
      directionDot += (combo.finalState[i * 12 + axis]! - noWind.finalState[i * 12 + axis]!) * WIND.direction[axis];
    }
  }
  return {
    ticks: TICKS, substeps: physics.substeps,
    dispatchPerTick: (2 + edgeColoring.colorCount + volumeColoring.colorCount + 2) * physics.substeps,
    combo: { per24: combo.per24, minSurfaceGap: combo.minGap, digest: combo.digest, digestEvolved: combo.digestEvolved },
    noWind: { per24: noWind.per24, minSurfaceGap: noWind.minSurfaceGap, digest: noWind.digest },
    replayBitwise: combo.digest === comboRepeat.digest,
    windEffective: combo.digest !== noWind.digest && directionDot > 0,
    directionDot,
    mirrorTolerance: 0.05,
    comboMirrorWithinTolerance: combo.per24.every(row => row.maxErrVsMirror <= 0.05),
    noWindMirrorWithinTolerance: noWind.per24.every(row => row.maxErrVsMirror <= 0.05),
    contactObserved: combo.minGap < 0.05,
    gpuExecuted: true,
  };
}

// —— [布料] 风+障碍组合:GPU(dispatchClothStepAuto) vs f64 黄金(wind+contacts) ——

const GRID = {
  columns: 12, rows: 12, spacing: 0.1, mass: 0.2,
  gravity: [0, -9.81, 0] as const, dtSeconds: 1 / 60, substeps: 8, compliance: 0, damping: 0.01,
  perturbation: 0.005, seed: 20260927, origin: [0, 0, 0] as const,
};
const PINNED = [[0, 11], [11, 11]] as const;
// 公平接触球位:z 向离面(旗初始 z=0 平面与球最近距离 0.5 > r=0.45 → 初始零穿透),
// 球心低位(y=0.15)使风致摆动的下摆段先触。历史球位 (0.55,0.5,0.05) 与旗初始深穿透
// (旗平面切过球体)= 投影序敏感最大化的不公平夹具,实测 A3 域 1.1-1.7(m与风无关,
// 本批对照列证据)——0.6177 登记项的真实根因族,场景随本批废弃。
const CLOTH_SPHERE = { center: [0.55, 0.15, 0.5] as const, radius: 0.45 };
// 布料组合场景风(z 向主分量把旗吹向球,z 漂移估算 ≈0.08 > 初始间隙 0.05)。
const CLOTH_WIND = { direction: [0.35, 0, 0.7] as const, baseSpeed: 1.5, gustFrequency: 0.9, spatialScale: 2.5, seed: 7 };

/**
 * [布料] 风×障碍公平夹具三列矩阵(归因设计,不挑点):
 * - A 列 有风无障碍:登记风容差 0.1 的在跑复证(黄金合同既有门,风向量同 C 列);
 * - B 列 无风有障碍:夹具有效性门——零风不触球(contact=false)且黄金差 ≤0.1
 *   (证明初始零穿透、非接触域序偏差有界);
 * - C 列 有风+障碍:组合主列——风致接触必须发生(contact=true,风是碰撞原因),
 *   预接触段黄金差 ≤0.1(接触前场景必须匹配登记风容差);接触后绝对黄金差按实测
 *   登记并归因(f64 构建序 vs f32 色序在接触滑动混沌域放大,家族口径与
 *   softbody-parallel-divergence 障碍登记同族),核级合同由公式级投影黄金(障碍刀
 *   球 1.1e-7 真机)+接触可观测承担,不以绝对门冒认或降门。
 */
export async function runClothWindObstacleCheck(): Promise<unknown> {
  const device = await gpuContext();
  const diag = GRID.spacing * Math.SQRT2;
  const constraints: Array<{ a: number; b: number; restLength: number }> = [];
  for (let r = 0; r < GRID.rows; r += 1) {
    for (let col = 0; col < GRID.columns; col += 1) {
      const i = r * GRID.columns + col;
      if (col + 1 < GRID.columns) constraints.push({ a: i, b: i + 1, restLength: GRID.spacing });
      if (r + 1 < GRID.rows) constraints.push({ a: i, b: i + GRID.columns, restLength: GRID.spacing });
      if (col + 1 < GRID.columns && r + 1 < GRID.rows) {
        constraints.push({ a: i, b: i + GRID.columns + 1, restLength: diag });
        constraints.push({ a: i + 1, b: i + GRID.columns, restLength: diag });
      }
    }
  }
  // 初始态 = buildClothParallelState(与 ClothSolver 构造扰动流逐位同源,黄金对拍
  // 前置合同;禁手搓零扰动初态——扰动流失配是 order-1 伪差源)。
  const build = buildClothParallelState({ ...GRID, pinned: PINNED });
  const state0 = build.state;
  const particleCount = build.particleCount;
  const particlesFromState = (state: Float32Array) => Array.from({ length: particleCount }, (_, i) => ({
    position: [state[i * 12]!, state[i * 12 + 1]!, state[i * 12 + 2]!],
    inverseMass: state[i * 12 + 3]!,
    velocity: [state[i * 12 + 4]!, state[i * 12 + 5]!, state[i * 12 + 6]!],
  }));
  const obstacles: Array<{ center: [number, number, number]; radius: number;
    rotation: readonly [number, number, number, number, number, number, number, number, number];
    halfExtents: readonly [number, number, number] }> =
    [{ center: [...CLOTH_SPHERE.center] as [number, number, number], radius: CLOTH_SPHERE.radius,
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], halfExtents: [0, 0, 0] }];
  const sphereProject = (px: Float64Array, py: Float64Array, pz: Float64Array, inverseMass: Float64Array): void => {
    for (let i = 0; i < inverseMass.length; i += 1) {
      if (inverseMass[i] === 0) continue;
      const dx = px[i]! - CLOTH_SPHERE.center[0]; const dy = py[i]! - CLOTH_SPHERE.center[1]; const dz = pz[i]! - CLOTH_SPHERE.center[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist < CLOTH_SPHERE.radius && dist > 0) {
        px[i] = CLOTH_SPHERE.center[0] + dx / dist * CLOTH_SPHERE.radius;
        py[i] = CLOTH_SPHERE.center[1] + dy / dist * CLOTH_SPHERE.radius;
        pz[i] = CLOTH_SPHERE.center[2] + dz / dist * CLOTH_SPHERE.radius;
      }
    }
  };
  interface ClothColumn { label: string; ticks: number; per8: Array<{ tick: number; maxErrVsGolden: number; contactYet: boolean }>;
    finalMaxErrVsGolden: number; maxPreContactErrVsGolden: number; contactObserved: boolean; kernel: string; fallbackSeen: string | null; }
  const runColumn = async (label: string, useWind: boolean, useObstacles: boolean): Promise<ClothColumn> => {
    const golden = new ClothSolver({
      ...GRID,
      ...(useWind ? { wind: CLOTH_WIND } : {}),
      ...(useObstacles ? { contacts: { project: sphereProject } } : {}),
    });
    for (const [col, row] of PINNED) golden.setPinned(col, row, true);
    const TICKS = 120;
    const per8: ClothColumn["per8"] = [];
    let gpuState = state0;
    let contactObserved = false;
    let finalErr = 0;
    let maxPreContactErr = 0;
    let kernel = "";
    let fallbackSeen: string | null = null;
    for (let tick = 1; tick <= TICKS; tick += 1) {
      golden.step();
      const result = await dispatchClothStepAuto(device, {
        particles: particlesFromState(gpuState), constraints,
        dtSeconds: GRID.dtSeconds, substeps: GRID.substeps, compliance: GRID.compliance,
        damping: GRID.damping, gravity: [...GRID.gravity],
        ...(useWind ? { wind: { ...CLOTH_WIND, tickSeconds: (tick - 1) * GRID.dtSeconds } } : {}),
        ...(useObstacles ? { obstacles } : {}),
      });
      gpuState = result.state;
      kernel = result.kernel;
      if (result.fallbackReason) fallbackSeen = result.fallbackReason;
      let contactThisTick = false;
      for (let i = 0; i < particleCount; i += 1) {
        const d = Math.hypot(gpuState[i * 12]! - CLOTH_SPHERE.center[0], gpuState[i * 12 + 1]! - CLOTH_SPHERE.center[1], gpuState[i * 12 + 2]! - CLOTH_SPHERE.center[2]);
        // 接触窗口 0.02(真面接触):B 列零风最小 |dist−r| ≈ 离面间隙 0.05,宽窗口会假阳。
        if (Math.abs(d - CLOTH_SPHERE.radius) < 0.02) { contactThisTick = true; break; }
      }
      if (contactThisTick) contactObserved = true;
      if (tick % 8 === 0 || tick === TICKS) {
        const snap = golden.capture();
        let err = 0;
        for (let i = 0; i < particleCount; i += 1) {
          err = Math.max(err, Math.hypot(
            gpuState[i * 12]! - snap.px[i]!, gpuState[i * 12 + 1]! - snap.py[i]!, gpuState[i * 12 + 2]! - snap.pz[i]!));
        }
        if (!contactObserved) maxPreContactErr = Math.max(maxPreContactErr, err);
        per8.push({ tick, maxErrVsGolden: err, contactYet: contactObserved });
        finalErr = err;
      }
    }
    return { label, ticks: TICKS, per8, finalMaxErrVsGolden: finalErr, maxPreContactErrVsGolden: maxPreContactErr,
      contactObserved, kernel, fallbackSeen };
  };
  // 归因矩阵:A 有风无障碍(风容差门)/B 无风有障碍(夹具有效性门)/C 风+障碍组合主列。
  const columnA = await runColumn("wind-no-obstacle", true, false);
  const columnB = await runColumn("no-wind-obstacle", false, true);
  const columnC = await runColumn("wind-obstacle-combo", true, true);
  return {
    ticks: 120, goldenTolerance: 0.1, gpuExecuted: true,
    columns: { A_windNoObstacle: columnA, B_noWindObstacle: columnB, C_windObstacleCombo: columnC },
    columnAGoldenWithinTolerance: columnA.finalMaxErrVsGolden <= 0.1,
    columnBFixtureValid: columnB.finalMaxErrVsGolden <= 0.1 && columnB.contactObserved === false,
    comboContactObserved: columnC.contactObserved === true,
    comboPreContactGoldenWithinTolerance: columnC.maxPreContactErrVsGolden <= 0.1,
    kernelParallelNoFallback: columnC.kernel === "cloth-parallel" && columnC.fallbackSeen === null,
  };
}
