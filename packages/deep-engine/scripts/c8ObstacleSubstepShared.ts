// C8 障碍接触逐子步对拍探针 共享职责(sourceSizeGate 拆分:自 c8ObstacleSubstepProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:场景常量、位置视图(state 12-stride 与 SoA 统一访问形态)、度量与摘要。

export const GRID = {
  columns: 12, rows: 12, spacing: 0.1, mass: 0.2,
  gravity: [0, -9.81, 0] as const, dtSeconds: 1 / 60, substeps: 8, compliance: 0, damping: 0.01,
  perturbation: 0.005, seed: 20260927, origin: [0, 0, 0] as const,
};
export const PINNED = [[0, 11], [11, 11]] as const;
export const TICKS = 64;
export const CHECKPOINTS = [8, 16, 32, 64];
export const OBSTACLE = { center: [0.55, 0.5, 0.05] as const, radius: 0.45 };
export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
export const ZERO_EXTENTS = [0, 0, 0] as const;

export const f = Math.fround;

// ─── 位置视图(state 12-stride 与 SoA 统一访问形态) ────────────────────────────────

export interface PositionView {
  x(i: number): number;
  y(i: number): number;
  z(i: number): number;
}

export function stateView(state: Float32Array): PositionView {
  return { x: (i) => state[i * 12]!, y: (i) => state[i * 12 + 1]!, z: (i) => state[i * 12 + 2]! };
}

export function soaView(px: Float64Array, py: Float64Array, pz: Float64Array): PositionView {
  return { x: (i) => px[i]!, y: (i) => py[i]!, z: (i) => pz[i]! };
}

// ─── 度量 ────────────────────────────────────────────────────────────────────────────

export function maxPosErr(a: PositionView, b: PositionView, n: number): { max: number; worst: number } {
  let max = 0; let worst = -1;
  for (let i = 0; i < n; i += 1) {
    const d = Math.hypot(a.x(i) - b.x(i), a.y(i) - b.y(i), a.z(i) - b.z(i));
    if (d > max) { max = d; worst = i; }
  }
  return { max, worst };
}

/** 接触量:inside 数(dist<r)、minSurfDist(最小 |dist-r|)、minDist、最近粒子。 */
export function contactStats(view: PositionView, n: number): {
  insideCount: number; minDist: number; minSurfDist: number; nearest: number;
} {
  let insideCount = 0; let minDist = Infinity; let minSurfDist = Infinity; let nearest = -1;
  for (let i = 0; i < n; i += 1) {
    const dx = view.x(i) - 0.55; const dy = view.y(i) - 0.5; const dz = view.z(i) - 0.05;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.45) insideCount += 1;
    if (dist < minDist) { minDist = dist; nearest = i; }
    const surf = Math.abs(dist - 0.45);
    if (surf < minSurfDist) minSurfDist = surf;
  }
  return { insideCount, minDist, minSurfDist, nearest };
}

export function particleAt(view: PositionView, i: number): number[] {
  return [view.x(i), view.y(i), view.z(i)].map((v) => Number(v.toFixed(6)));
}

export function stateDigest(state: Float32Array): string {
  let h = 0x811c9dc1;
  for (const byte of new Uint8Array(state.buffer, state.byteOffset, state.byteLength)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16);
}

// ─── 主探针行结构 ────────────────────────────────────────────────────────────────────

export interface SubstepRow {
  tick: number; sub: number;
  errGpuGolden: number; errGpuMirror: number; errMirrorGolden: number; errGoldenOrder: number;
  worstGpuGolden: number;
  insideGpu: number; insideGolden: number;
  minSurfDistGpu: number; minSurfDistGolden: number;
}
