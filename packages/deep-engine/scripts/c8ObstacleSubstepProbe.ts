// C8 障碍接触场景逐子步对拍探针(定位批遗留:GPU obstacles vs f64 黄金 contacts
// 64 tick goldenErr=0.6177 超门 0.1)。由 scripts/c8ObstacleSubstepRun.mjs 打包驱动。
//
// 证据口径(如实声明):
// - 底座 = clothParallelGpuProbe.ts 障碍场景原参数(GRID/PINNED/球障碍 0.55,0.5,0.05 r=0.45,
//   64 tick);本探针不改底座文件,只做逐子步分解测量;
// - 子步分解:dispatchClothStepAuto 以 substeps=1、dtSeconds=dt/8 逐子步调用,h = fround(dt/8)
//   与 8 子步整 tick 的 fround(dt)/8 逐位同值(÷8 为 2 的幂精确移指);保真性由
//   分解轨迹 vs bulk 整 tick 轨迹终点逐位对拍独立验证;
// - 四方对拍(全部逐子步锁步推进):GPU(f32 色序+obstacles) / 本地 f32 镜像(色序+obstacles,
//   逐运算 fround,与 WGSL 逐式同构——补 ClothParallelMirror 无 obstacles 通道的缺口) /
//   f64 黄金(构建序+contacts,stepSubstep 逐子步,闭包与底座逐字同式) /
//   f64 色序变体(contacts 不变,仅约束批序换色桶序,分离"投影序"单一因素);
// - 接触量:每子步 insideCount(dist<r 粒子数)、minSurfDist,用于首接触定位;
// - 混沌判据:GPU-vs-黄金误差首越 1e-3 的子步处,对 f64 色序轨道做 1-ULP 扰动克隆,
//   双轨继续 f64 推进;若同样放大到 O(0.1+) 则场景本身混沌,任何 f32 级输入差都放大(候选 A 判据)。
//
// sourceSizeGate 拆分(2026-10-03):按职责分文件,代码逐行同源仅改可见性,语义零变化;
// 本文件保留 runner 合同入口(probeAdapterInfo / runC8ObstacleSubstepProbe):
//   常量/视图/度量 → c8ObstacleSubstepShared.ts;本地 f32 镜像 → c8ObstacleSubstepMirror.ts;
//   f64 色序变体 → c8ObstacleColorOrder.ts。
import {
  buildClothParallelState,
} from "../src/physics/clothParallelSolver.js";
import type { ClothSnapshot } from "../src/physics/clothSolver.js";
import { ClothSolver } from "../src/physics/clothSolver.js";
import { dispatchClothStepAuto } from "../src/physics/softBodyGpuDispatch.clothParallel.js";
import { GRID, PINNED, TICKS, CHECKPOINTS, OBSTACLE, IDENTITY, ZERO_EXTENTS,
  stateView, soaView, maxPosErr, contactStats, particleAt, stateDigest,
  type SubstepRow } from "./c8ObstacleSubstepShared.js";
import { mirrorSubstep } from "./c8ObstacleSubstepMirror.js";
import { goldenContactsProject, ClothSolverColorOrder } from "./c8ObstacleColorOrder.js";

/** runner 预检:适配器可用性(骨架同 clothParallelGpuProbe.probeAdapterInfo)。 */
export async function probeAdapterInfo(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return adapter.info ?? {};
}

export async function runC8ObstacleSubstepProbe(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const build = buildClothParallelState({ ...GRID, pinned: [...PINNED] });
  const n = build.particleCount;
  const coloring = build.coloring;
  const particlesFromState = (state: Float32Array) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const base = i * 12;
      out.push({
        position: [state[base]!, state[base + 1]!, state[base + 2]!] as [number, number, number],
        inverseMass: state[base + 3]!,
        velocity: [state[base + 4]!, state[base + 5]!, state[base + 6]!] as [number, number, number],
      });
    }
    return out;
  };
  const physics = {
    constraints: (() => {
      const diag = GRID.spacing * Math.SQRT2;
      const constraints = [];
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
      return constraints;
    })(),
    particles: particlesFromState(build.state),
    dtSeconds: GRID.dtSeconds, substeps: GRID.substeps,
    compliance: GRID.compliance, damping: GRID.damping, gravity: [...GRID.gravity] as [number, number, number],
  };
  const obstacles = [{
    center: [...OBSTACLE.center] as [number, number, number], radius: OBSTACLE.radius,
    rotation: [...IDENTITY] as [number, number, number, number, number, number, number, number, number],
    halfExtents: [...ZERO_EXTENTS] as [number, number, number],
  }];

  // 轨道①:bulk 整 tick(生产形态,1 dispatch/tick)——复现锚点 + 分解保真参照 + 双跑逐位。
  const makeGolden = (): ClothSolver => {
    const golden = new ClothSolver({ ...GRID, contacts: { project: goldenContactsProject } });
    for (const [col, row] of PINNED) golden.setPinned(col, row, true);
    return golden;
  };
  const runBulk = async (ticks: number): Promise<{ state: Float32Array; digest: string; goldenErrByTick: Record<number, number> }> => {
    let state = build.state;
    const goldenErrByTick: Record<number, number> = {};
    const golden = makeGolden();
    for (let tick = 1; tick <= ticks; tick += 1) {
      golden.step();
      state = (await dispatchClothStepAuto(device, { ...physics, particles: particlesFromState(state), obstacles })).state;
      if (CHECKPOINTS.includes(tick)) {
        const snap = golden.capture();
        goldenErrByTick[tick] = maxPosErr(stateView(state), soaView(snap.px, snap.py, snap.pz), n).max;
      }
    }
    return { state, digest: stateDigest(state), goldenErrByTick };
  };
  const bulk1 = await runBulk(TICKS);
  const bulk2 = await runBulk(TICKS);
  const bulkGolden = makeGolden();
  for (let t = 0; t < TICKS; t += 1) bulkGolden.step();
  const bulkGoldenSnap: ClothSnapshot = bulkGolden.capture();
  const bulkGoldenErr = maxPosErr(stateView(bulk1.state), soaView(bulkGoldenSnap.px, bulkGoldenSnap.py, bulkGoldenSnap.pz), n);

  // 轨道②:子步分解(substeps=1、dt/8,逐子步读回)+ 同步三方 CPU 轨道(全部逐子步锁步)。
  const mirrorState = new Float32Array(build.state);
  const mirrorView = stateView(mirrorState);
  const golden = makeGolden();
  const goldenPos = golden.particleBuffers();
  const goldenView = soaView(goldenPos.px, goldenPos.py, goldenPos.pz);
  const goldenColor = new ClothSolverColorOrder(coloring);
  const colorPos = goldenColor.positions();
  const colorView = soaView(colorPos.px, colorPos.py, colorPos.pz);
  const substepDt = GRID.dtSeconds / GRID.substeps;
  const rows: SubstepRow[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  let decomposedState = build.state;
  let chaosClone: ClothSolverColorOrder | null = null;
  const f64Chaos = { onsetTick: -1, onsetSub: -1, worstIndex: -1, diverged: 0 };
  const contactOnset = { tick: -1, sub: -1, insideGpu: 0, insideGolden: 0, minSurfDistGpu: NaN, minSurfDistGolden: NaN, nearest: -1 };

  for (let tick = 1; tick <= TICKS; tick += 1) {
    for (let sub = 0; sub < GRID.substeps; sub += 1) {
      decomposedState = (await dispatchClothStepAuto(device, {
        ...physics, particles: particlesFromState(decomposedState),
        dtSeconds: substepDt, substeps: 1, obstacles,
      })).state;
      golden.stepSubstep(sub);
      goldenColor.stepSubstep();
      mirrorSubstep(build, mirrorState);
      const gpuView = stateView(decomposedState);
      const errGpuGolden = maxPosErr(gpuView, goldenView, n);
      const errGpuMirror = maxPosErr(gpuView, mirrorView, n);
      const errMirrorGolden = maxPosErr(mirrorView, goldenView, n);
      const errGoldenOrder = maxPosErr(goldenView, colorView, n);
      const statsGpu = contactStats(gpuView, n);
      const statsGolden = contactStats(goldenView, n);
      rows.push({
        tick, sub,
        errGpuGolden: errGpuGolden.max, errGpuMirror: errGpuMirror.max,
        errMirrorGolden: errMirrorGolden.max, errGoldenOrder: errGoldenOrder.max,
        worstGpuGolden: errGpuGolden.worst,
        insideGpu: statsGpu.insideCount, insideGolden: statsGolden.insideCount,
        minSurfDistGpu: statsGpu.minSurfDist, minSurfDistGolden: statsGolden.minSurfDist,
      });
      if (contactOnset.tick < 0 && (statsGpu.insideCount > 0 || statsGolden.insideCount > 0)) {
        Object.assign(contactOnset, {
          tick, sub,
          insideGpu: statsGpu.insideCount, insideGolden: statsGolden.insideCount,
          minSurfDistGpu: statsGpu.minSurfDist, minSurfDistGolden: statsGolden.minSurfDist,
          nearest: statsGolden.nearest >= 0 ? statsGolden.nearest : statsGpu.nearest,
        });
      }
      // 混沌判据:首个 GPU-vs-黄金误差越 1e-3 的子步,克隆 f64 色序轨(+1 ULP)并从此锁步推进。
      if (!chaosClone && errGpuGolden.max > 1e-3) {
        f64Chaos.onsetTick = tick; f64Chaos.onsetSub = sub; f64Chaos.worstIndex = errGpuGolden.worst;
        chaosClone = goldenColor.perturbClone(coloring, errGpuGolden.worst, 1);
      }
      if (chaosClone) {
        chaosClone.stepSubstep();
        f64Chaos.diverged = Math.max(f64Chaos.diverged, maxPosErr(soaView(chaosClone.positions().px, chaosClone.positions().py, chaosClone.positions().pz), colorView, n).max);
      }
    }
    if (CHECKPOINTS.includes(tick)) {
      const snap = golden.capture();
      const snapView = soaView(snap.px, snap.py, snap.pz);
      const gpuGolden = maxPosErr(stateView(decomposedState), snapView, n);
      checkpoints.push({
        tick,
        gpuVsGoldenMax: gpuGolden.max, worstParticle: gpuGolden.worst,
        gpuPos: particleAt(stateView(decomposedState), gpuGolden.worst),
        goldenPos: particleAt(snapView, gpuGolden.worst),
        gpuVsMirror: maxPosErr(stateView(decomposedState), mirrorView, n).max,
        mirrorVsGolden: maxPosErr(mirrorView, goldenView, n).max,
        goldenVsColorOrder: maxPosErr(goldenView, colorView, n).max,
        f64ChaosDiverged: chaosClone ? f64Chaos.diverged : null,
        insideGpu: contactStats(stateView(decomposedState), n).insideCount,
        insideGolden: contactStats(snapView, n).insideCount,
      });
    }
  }
  const decomposedGoldenErr = maxPosErr(stateView(decomposedState), soaView(bulkGoldenSnap.px, bulkGoldenSnap.py, bulkGoldenSnap.pz), n);
  const final = {
    decomposedVsGoldenFinal: decomposedGoldenErr.max,
    decomposedVsBulkBitwise: stateDigest(decomposedState) === bulk1.digest,
    bulkDoubleRunBitwise: bulk1.digest === bulk2.digest,
    bulkGoldenErrFinal: bulkGoldenErr.max,
    colorOrderVsGoldenFinal: maxPosErr(colorView, soaView(bulkGoldenSnap.px, bulkGoldenSnap.py, bulkGoldenSnap.pz), n).max,
    f64Chaos: { ...f64Chaos },
    worstGpuFinal: particleAt(stateView(decomposedState), decomposedGoldenErr.worst),
    worstGoldenFinal: particleAt(soaView(bulkGoldenSnap.px, bulkGoldenSnap.py, bulkGoldenSnap.pz), decomposedGoldenErr.worst),
  };

  const firstOver = (key: keyof SubstepRow, threshold: number): { tick: number; sub: number; value: number } | null => {
    for (const row of rows) if ((row[key] as number) > threshold) return { tick: row.tick, sub: row.sub, value: Number((row[key] as number).toExponential(4)) };
    return null;
  };
  const milestones = {
    gpuGolden: {
      over1e_6: firstOver("errGpuGolden", 1e-6), over1e_4: firstOver("errGpuGolden", 1e-4),
      over1e_3: firstOver("errGpuGolden", 1e-3), over1e_2: firstOver("errGpuGolden", 1e-2),
      over1e_1: firstOver("errGpuGolden", 1e-1),
    },
    mirrorGolden: { over1e_3: firstOver("errMirrorGolden", 1e-3), over1e_2: firstOver("errMirrorGolden", 1e-2), over1e_1: firstOver("errMirrorGolden", 1e-1) },
    goldenOrder: { over1e_3: firstOver("errGoldenOrder", 1e-3), over1e_2: firstOver("errGoldenOrder", 1e-2), over1e_1: firstOver("errGoldenOrder", 1e-1) },
    gpuMirror: { over1e_5: firstOver("errGpuMirror", 1e-5), over1e_3: firstOver("errGpuMirror", 1e-3), over1e_2: firstOver("errGpuMirror", 1e-2) },
    contactOnset,
  };

  device.destroy?.();
  return {
    schema: "c8-obstacle-substep-probe-v1",
    grid: GRID, pinned: PINNED, obstacle: OBSTACLE, ticks: TICKS, checkpointsAt: CHECKPOINTS,
    coloring: { colorCount: coloring.colorCount, colorRanges: coloring.colorRanges },
    decomposition: {
      note: "substeps=1 + dt/8 逐子步 dispatch;与 bulk 整 tick 轨迹终点逐位对拍为保真证据",
      finalBitwiseEqual: final.decomposedVsBulkBitwise,
      bulkDoubleRunBitwise: final.bulkDoubleRunBitwise,
    },
    anchors: {
      bulkGoldenErrByTick: bulk1.goldenErrByTick,
      bulkGoldenErrFinal: final.bulkGoldenErrFinal,
      priorAnchor: { goldenErr: 0.6177282211825479, note: "cloth-parallel-gpu-20260929-r1 evidence.json obstacles.goldenMaxPosErr" },
    },
    milestones,
    checkpoints,
    substepRows: rows,
    final,
  };
}
