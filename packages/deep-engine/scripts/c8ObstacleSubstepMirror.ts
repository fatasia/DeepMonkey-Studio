// C8 障碍接触逐子步对拍探针 本地 f32 镜像(sourceSizeGate 拆分:自 c8ObstacleSubstepProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:带 obstacles 的逐运算 fround 镜像(ClothParallelMirror 无障碍通道,此处逐运算
// fround 同构,与 WGSL projectObstacles/projectConstraintsColor 逐式对齐)。
import type { buildClothParallelState } from "../src/physics/clothParallelSolver.js";
import { OBSTACLE, f } from "./c8ObstacleSubstepShared.js";

/** WGSL projectObstacles sphere 分支的逐运算 f32 镜像(单障碍固定序;dist==0 分支同构)。 */
function mirrorProjectObstacles(state: Float32Array, particleCount: number): void {
  const cx = f(OBSTACLE.center[0]); const cy = f(OBSTACLE.center[1]); const cz = f(OBSTACLE.center[2]);
  const radius = f(OBSTACLE.radius);
  for (let i = 0; i < particleCount; i += 1) {
    const base = i * 12;
    if (state[base + 3]! === 0) continue;
    let px = state[base]!; let py = state[base + 1]!; let pz = state[base + 2]!;
    const dx = f(px - cx); const dy = f(py - cy); const dz = f(pz - cz);
    const dist = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
    if (dist < radius && dist > 0) {
      px = f(cx + f(f(dx / dist) * radius));
      py = f(cy + f(f(dy / dist) * radius));
      pz = f(cz + f(f(dz / dist) * radius));
    } else if (dist === 0) {
      px = f(cx + radius); py = cy; pz = cz;
    }
    state[base] = px; state[base + 1] = py; state[base + 2] = pz;
  }
}

/** 单色桶约束投影(与 clothParallelSolver.ts #projectBucket / WGSL projectConstraintsColor 逐运算同构)。 */
function mirrorProjectBucket(state: Float32Array, ints: Uint32Array, floats: Float32Array,
  bucket: number, alphaTilde: number): void {
  const a = ints[bucket * 4]!; const b = ints[bucket * 4 + 1]!; const restLength = floats[bucket * 4 + 2]!;
  const aBase = a * 12; const bBase = b * 12;
  const wa = state[aBase + 3]!; const wb = state[bBase + 3]!;
  const denom = f(wa + wb);
  if (denom === 0) return;
  const dx = f(state[aBase]! - state[bBase]!);
  const dy = f(state[aBase + 1]! - state[bBase + 1]!);
  const dz = f(state[aBase + 2]! - state[bBase + 2]!);
  const lenSq = f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
  const len = f(Math.sqrt(lenSq));
  if (len === 0) return;
  const numerator = f(restLength - len);
  const denominator = f(denom + alphaTilde);
  const correction = f(numerator / denominator);
  if (correction === 0) return;
  const invLen = f(1 / len);
  const nx = f(dx * invLen); const ny = f(dy * invLen); const nz = f(dz * invLen);
  const scaleA = f(correction * wa); const scaleB = f(correction * wb);
  state[aBase] = f(state[aBase]! + f(nx * scaleA));
  state[aBase + 1] = f(state[aBase + 1]! + f(ny * scaleA));
  state[aBase + 2] = f(state[aBase + 2]! + f(nz * scaleA));
  state[bBase] = f(state[bBase]! - f(nx * scaleB));
  state[bBase + 1] = f(state[bBase + 1]! - f(ny * scaleB));
  state[bBase + 2] = f(state[bBase + 2]! - f(nz * scaleB));
}

/** 本地 f32 镜像单子步:integrate → obstacles → 色序约束 → obstacles → 速度回算。 */
export function mirrorSubstep(build: ReturnType<typeof buildClothParallelState>, state: Float32Array): void {
  const cfg = build.config;
  const dt32 = f(cfg.dtSeconds);
  const h = f(dt32 / cfg.substeps);
  const hh = f(h * h);
  const alphaTilde = f(f(cfg.compliance) / hh);
  const dampingScale = f(1 - f(f(cfg.damping) * h));
  const invH = f(1 / h);
  const gx = f(cfg.gravity[0]); const gy = f(cfg.gravity[1]); const gz = f(cfg.gravity[2]);
  const ints = new Uint32Array(build.constraintBuffer);
  const floats = new Float32Array(build.constraintBuffer);
  // pass A:integrate(无风;与 WGSL integrateParticles 逐运算同构)。
  for (let i = 0; i < build.particleCount; i += 1) {
    const base = i * 12;
    state[base + 8] = state[base]!; state[base + 9] = state[base + 1]!; state[base + 10] = state[base + 2]!;
    if (state[base + 3]! === 0) {
      state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
      continue;
    }
    state[base + 4] = f(f(state[base + 4]! + f(gx * h)) * dampingScale);
    state[base + 5] = f(f(state[base + 5]! + f(gy * h)) * dampingScale);
    state[base + 6] = f(f(state[base + 6]! + f(gz * h)) * dampingScale);
    state[base] = f(state[base]! + f(state[base + 4]! * h));
    state[base + 1] = f(state[base + 1]! + f(state[base + 5]! * h));
    state[base + 2] = f(state[base + 2]! + f(state[base + 6]! * h));
  }
  // pass B2(前):obstacles。
  mirrorProjectObstacles(state, build.particleCount);
  // pass B:色序约束投影。
  for (let color = 0; color < build.coloring.colorCount; color += 1) {
    const [start, end] = build.coloring.colorRanges[color]!;
    for (let bucket = start; bucket < end; bucket += 1) mirrorProjectBucket(state, ints, floats, bucket, alphaTilde);
  }
  // pass B2(后):obstacles。
  mirrorProjectObstacles(state, build.particleCount);
  // pass C:速度回算。
  for (let i = 0; i < build.particleCount; i += 1) {
    const base = i * 12;
    if (state[base + 3]! === 0) {
      state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
      continue;
    }
    state[base + 4] = f(f(state[base]! - state[base + 8]!) * invH);
    state[base + 5] = f(f(state[base + 1]! - state[base + 9]!) * invH);
    state[base + 6] = f(f(state[base + 2]! - state[base + 10]!) * invH);
  }
}
