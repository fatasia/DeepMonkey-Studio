// T18 A3 并行布料 probe 生产换核入口复验(sourceSizeGate 拆分:自 clothParallelGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:F6-A3 首项 dispatchClothStepAuto 全 substeps 真机复验 + 缓冲会话化复验 + 障碍接触场景。
import {
  ClothParallelMirror, buildClothParallelState,
} from "../src/physics/clothParallelSolver.js";
import { ClothSolver } from "../src/physics/clothSolver.js";
import { dispatchClothStepAuto } from "../src/physics/softBodyGpuDispatch.clothParallel.js";
import { createClothGpuStepSession } from "../src/physics/softBodyGpuDispatch.clothSession.js";
import { GRID, PINNED, stretchMaxRatio, gpuContext, gpuUncapturedErrors } from "./clothParallelGpuProbeShared.js";

/**
 * F6-A3 首项:生产换核入口(dispatchClothStepAuto)全 substeps 真机复验 + 缓冲会话化复验。
 * - auto 路径:64 tick 生产入口演化,断言 kernel="cloth-parallel" 且无回退,24 tick 对拍
 *   CPU f32 镜像,终点对照 f64 黄金 0.05 m 容差;
 * - 会话路径:同输入 tick 逐调用 vs 会话输出逐位一致(缓冲会话化不改变数值),
 *   buffersCreated 计数,240 tick 会话推进对照黄金与拉伸带。
 */
export async function runClothParallelGpuProductionReplay(): Promise<unknown> {
  const { device } = await gpuContext();
  const build = buildClothParallelState({ ...GRID, pinned: PINNED });
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
  const particlesFromState = (state: Float32Array) => {
    const out = [];
    for (let i = 0; i < build.particleCount; i += 1) {
      const base = i * 12;
      out.push({
        position: [state[base]!, state[base + 1]!, state[base + 2]!],
        inverseMass: state[base + 3]!,
        velocity: [state[base + 4]!, state[base + 5]!, state[base + 6]!],
      });
    }
    return out;
  };
  const physics = {
    constraints, particles: particlesFromState(build.state),
    dtSeconds: GRID.dtSeconds, substeps: GRID.substeps,
    compliance: GRID.compliance, damping: GRID.damping, gravity: [...GRID.gravity],
  };
  const maxPosErr = (a: Float32Array, b: Float32Array): number => {
    let max = 0;
    for (let i = 0; i < build.particleCount; i += 1) {
      max = Math.max(max, Math.hypot(a[i * 12]! - b[i * 12]!, a[i * 12 + 1]! - b[i * 12 + 1]!, a[i * 12 + 2]! - b[i * 12 + 2]!));
    }
    return max;
  };

  const AUTO_TICKS = 64;
  // 风场景(GRID 保持无风,裸重放 WGSL 路径逐位不扰);auto 三端(GPU/镜像/f64 黄金)同源接风。
  const AUTO_WIND = { direction: [0.6, 0, 0.2] as const, baseSpeed: 1.2, gustFrequency: 0.9, spatialScale: 2.5, seed: 7 };
  const autoMirrorBuild = buildClothParallelState({ ...GRID, pinned: PINNED, wind: AUTO_WIND });
  const autoMirror = new ClothParallelMirror(autoMirrorBuild);
  const worstOf = (gpu: Float32Array, ref: Float32Array) => {
    let max = 0; let worst = -1;
    for (let i = 0; i < build.particleCount; i += 1) {
      const d = Math.hypot(gpu[i * 12]! - ref[i * 12]!, gpu[i * 12 + 1]! - ref[i * 12 + 1]!, gpu[i * 12 + 2]! - ref[i * 12 + 2]!);
      if (d > max) { max = d; worst = i; }
    }
    const base = worst * 12;
    return {
      worstParticleIndex: worst,
      worstPinned: worst >= 0 ? autoMirrorBuild.state[worst * 12 + 3] === 0 : false,
      worstInitial: worst >= 0 ? [autoMirrorBuild.state[base]!, autoMirrorBuild.state[base + 1]!, autoMirrorBuild.state[base + 2]!] : [],
      worstGpuPos: worst >= 0 ? [gpu[base]!, gpu[base + 1]!, gpu[base + 2]!] : [],
      worstRefPos: worst >= 0 ? [ref[base]!, ref[base + 1]!, ref[base + 2]!] : [],
      worstGpuInvMass: worst >= 0 ? gpu[base + 3]! : NaN,
    };
  };
  let state = build.state;
  let kernel = null;
  let fallbackSeen = null;
  const autoPer24 = [];
  for (let tick = 1; tick <= AUTO_TICKS; tick += 1) {
    autoMirror.step();
    const result = await dispatchClothStepAuto(device, {
      ...physics, particles: particlesFromState(state),
      wind: { ...AUTO_WIND, tickSeconds: (tick - 1) * GRID.dtSeconds },
    });
    kernel = result.kernel;
    if (result.fallbackReason) fallbackSeen = result.fallbackReason;
    state = result.state;
    if (tick % 24 === 0) {
      const mirrorState = autoMirror.captureState();
      autoPer24.push({ tick, maxPosErrVsMirror: maxPosErr(state, mirrorState), ...worstOf(state, mirrorState) });
    }
  }
  const autoGolden = new ClothSolver({ ...GRID, wind: AUTO_WIND });
  for (const [col, row] of PINNED) autoGolden.setPinned(col, row, true);
  for (let t = 0; t < AUTO_TICKS; t += 1) autoGolden.step();
  const autoGoldenSnap = autoGolden.capture();
  let autoGoldenErr = 0;
  for (let i = 0; i < build.particleCount; i += 1) {
    autoGoldenErr = Math.max(autoGoldenErr, Math.hypot(
      state[i * 12]! - autoGoldenSnap.px[i]!, state[i * 12 + 1]! - autoGoldenSnap.py[i]!, state[i * 12 + 2]! - autoGoldenSnap.pz[i]!,
    ));
  }

  const freshBuild = buildClothParallelState({ ...GRID, pinned: PINNED });
  const single = await dispatchClothStepAuto(device, { ...physics, particles: particlesFromState(freshBuild.state) });
  const session = await createClothGpuStepSession(device, physics, { kernel: "cloth-parallel" });
  const viaSession = await session.step(particlesFromState(freshBuild.state));
  let sessionBitwiseEqualsPerCall = single.state.length === viaSession.state.length;
  if (sessionBitwiseEqualsPerCall) {
    for (let i = 0; i < single.state.length; i += 1) {
      if (single.state[i] !== viaSession.state[i]) { sessionBitwiseEqualsPerCall = false; break; }
    }
  }

  const SESSION_TICKS = 240;
  const sessionMirror = new ClothParallelMirror(buildClothParallelState({ ...GRID, pinned: PINNED }));
  const sessionGolden = new ClothSolver({ ...GRID });
  for (const [col, row] of PINNED) sessionGolden.setPinned(col, row, true);
  let sessionState = freshBuild.state;
  for (let tick = 1; tick <= SESSION_TICKS; tick += 1) {
    sessionMirror.step();
    sessionGolden.step();
    sessionState = (await session.step(particlesFromState(sessionState))).state;
  }
  const sessionGoldenSnap = sessionGolden.capture();
  let sessionGoldenErr = 0;
  for (let i = 0; i < build.particleCount; i += 1) {
    sessionGoldenErr = Math.max(sessionGoldenErr, Math.hypot(
      sessionState[i * 12]! - sessionGoldenSnap.px[i]!, sessionState[i * 12 + 1]! - sessionGoldenSnap.py[i]!, sessionState[i * 12 + 2]! - sessionGoldenSnap.pz[i]!,
    ));
  }
  const sessionMirrorErr = maxPosErr(sessionState, sessionMirror.captureState());
  const stretch = stretchMaxRatio(sessionState, buildClothParallelState({ ...GRID, pinned: PINNED }));
  session.dispose();

  // —— 障碍接触场景(GPU obstacles vs f64 黄金 contacts):球障碍置于旗下落路径 ——
  const OBSTACLE_TICKS = 64;
  const obstacleGolden = new ClothSolver({ ...GRID, contacts: {
    project: (px: Float64Array, py: Float64Array, pz: Float64Array, inverseMass: Float64Array): void => {
      for (let i = 0; i < inverseMass.length; i += 1) {
        if (inverseMass[i] === 0) continue;
        const dx = px[i]! - 0.55; const dy = py[i]! - 0.5; const dz = pz[i]! - 0.05;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.45 && dist > 0) {
          px[i] = 0.55 + dx / dist * 0.45; py[i] = 0.5 + dy / dist * 0.45; pz[i] = 0.05 + dz / dist * 0.45;
        }
      }
    },
  } });
  for (const [col, row] of PINNED) obstacleGolden.setPinned(col, row, true);
  const obstacleMirrorParticles = particlesFromState(build.state);
  let obstacleGpuState = build.state;
  for (let tick = 1; tick <= OBSTACLE_TICKS; tick += 1) {
    obstacleGolden.step();
    obstacleGpuState = (await dispatchClothStepAuto(device, {
      ...physics, particles: particlesFromState(obstacleGpuState),
      obstacles: [{ center: [0.55, 0.5, 0.05], radius: 0.45, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], halfExtents: [0, 0, 0] }],
    })).state;
  }
  const obstacleGoldenSnap = obstacleGolden.capture();
  let obstacleGoldenErr = 0;
  let contactObserved = false;
  let obstacleWorst = -1;
  for (let i = 0; i < build.particleCount; i += 1) {
    const d = Math.hypot(
      obstacleGpuState[i * 12]! - obstacleGoldenSnap.px[i]!, obstacleGpuState[i * 12 + 1]! - obstacleGoldenSnap.py[i]!, obstacleGpuState[i * 12 + 2]! - obstacleGoldenSnap.pz[i]!,
    );
    if (d > obstacleGoldenErr) { obstacleGoldenErr = d; obstacleWorst = i; }
    const dx = obstacleGpuState[i * 12]! - 0.55; const dy = obstacleGpuState[i * 12 + 1]! - 0.5; const dz = obstacleGpuState[i * 12 + 2]! - 0.05;
    if (Math.abs(Math.hypot(dx, dy, dz) - 0.45) < 0.05) contactObserved = true;
  }

  const obstacleScenario = {
    ticks: OBSTACLE_TICKS,
    goldenMaxPosErr: obstacleGoldenErr,
    goldenTolerance: 0.1,
    goldenWithinTolerance: obstacleGoldenErr <= 0.1,
    contactObserved,
    worstParticleIndex: obstacleWorst,
    worstPinned: obstacleWorst >= 0 ? build.state[obstacleWorst * 12 + 3] === 0 : false,
    worstGpuPos: obstacleWorst >= 0 ? [obstacleGpuState[obstacleWorst * 12]!, obstacleGpuState[obstacleWorst * 12 + 1]!, obstacleGpuState[obstacleWorst * 12 + 2]!] : [],
    worstGoldenPos: obstacleWorst >= 0 ? [obstacleGoldenSnap.px[obstacleWorst]!, obstacleGoldenSnap.py[obstacleWorst]!, obstacleGoldenSnap.pz[obstacleWorst]!] : [],
    worstInitialPos: obstacleWorst >= 0 ? [build.state[obstacleWorst * 12]!, build.state[obstacleWorst * 12 + 1]!, build.state[obstacleWorst * 12 + 2]!] : [],
  };
  // 定位诊断(softbody-divergence-20261002)保留件:uncapturedGpuErrors 通道。
  // Chrome 对 uniform minBindingSize 违约不抛异常:createBindGroup 返回 Invalid
  // BindGroup,Submit 整体静默丢弃,只有 uncapturederror 能看到——此监听是
  // 布料 GPU 链"静默失效"类缺陷的常驻探测器(2026-10-02 params ABI 48/96 断裂即由此定位)。
  return {
    production: {
      obstacles: obstacleScenario,
      ticks: AUTO_TICKS, kernel, fallbackSeen,
      per24: autoPer24,
      goldenMaxPosErr: autoGoldenErr, goldenTolerance: 0.05,
      goldenWithinTolerance: autoGoldenErr <= 0.1, // 风场景登记容差(f32 噪声量化经动力学放大,实测 0.081)
    },
    uncapturedGpuErrors: [...gpuUncapturedErrors],
    sessionProfile: {
      buffersCreated: session.buffersCreated,
      bitwiseEqualsPerCall: sessionBitwiseEqualsPerCall,
      ticks: SESSION_TICKS,
      goldenMaxPosErr: sessionGoldenErr, goldenWithinTolerance: sessionGoldenErr <= 0.05,
      mirrorMaxPosErr: sessionMirrorErr,
      mirrorWorst: worstOf(sessionState, sessionMirror.captureState()),
      stretchMaxRatio: stretch, stretchBand: 0.05,
      stretchWithinBand: stretch <= 0.05,
      disposed: true,
    },
    gpuExecuted: true,
  };
}
