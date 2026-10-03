// C8 障碍接触逐子步对拍探针 f64 色序变体(sourceSizeGate 拆分:自 c8ObstacleSubstepProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:contacts 黄金投影闭包、f64 ULP 扰动原语、ClothSolver 色序变体(分离"投影序"单一因素)。
import type { ClothColoring } from "../src/physics/clothConstraintColoring.js";
import { GRID, PINNED } from "./c8ObstacleSubstepShared.js";

export function goldenContactsProject(px: Float64Array, py: Float64Array, pz: Float64Array, inverseMass: Float64Array): void {
  for (let i = 0; i < inverseMass.length; i += 1) {
    if (inverseMass[i] === 0) continue;
    const dx = px[i]! - 0.55; const dy = py[i]! - 0.5; const dz = pz[i]! - 0.05;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.45 && dist > 0) {
      px[i] = 0.55 + dx / dist * 0.45; py[i] = 0.5 + dy / dist * 0.45; pz[i] = 0.05 + dz / dist * 0.45;
    }
  }
}

/** f64 ULP 推进(x 的 IEEE-754 双精度位型 ±n ULP;保号单调)。 */
function bumpUlps(x: number, ulps: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  bits = (x < 0 || (x === 0 && Object.is(x, -0))) ? bits - BigInt(ulps) : bits + BigInt(ulps);
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

/** f64 布料求解器色序变体:构造逐位同 ClothSolver(mulberry 流同源),stepSubstep 的
 * 约束循环从构建序改为色桶序,其余(contacts 双投影/速度回算/锚点)逐式同构。
 * 同类实例互访 #私有字段(JS 语义允许),perturbClone 由此实现状态克隆。 */
export class ClothSolverColorOrder {
  readonly #count: number;
  readonly #px: Float64Array; readonly #py: Float64Array; readonly #pz: Float64Array;
  readonly #vx: Float64Array; readonly #vy: Float64Array; readonly #vz: Float64Array;
  readonly #qx: Float64Array; readonly #qy: Float64Array; readonly #qz: Float64Array;
  readonly #invMass: Float64Array;
  readonly #ca: Int32Array; readonly #cb: Int32Array; readonly #rest: Float64Array;
  readonly #order: Uint32Array;
  constructor(coloring: ClothColoring) {
    const c = GRID;
    this.#count = c.columns * c.rows;
    const n = this.#count;
    this.#px = new Float64Array(n); this.#py = new Float64Array(n); this.#pz = new Float64Array(n);
    this.#vx = new Float64Array(n); this.#vy = new Float64Array(n); this.#vz = new Float64Array(n);
    this.#qx = new Float64Array(n); this.#qy = new Float64Array(n); this.#qz = new Float64Array(n);
    this.#invMass = new Float64Array(n).fill(1 / c.mass);
    // 构造逐位同 clothSolver.ts(mulberry 流同序消费;origin=[0,0,0] 与黄金一致)。
    let s = (c.seed | 0) + 0x9e3779b9 | 0;
    const nextUnit = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let r = 0; r < c.rows; r += 1) {
      for (let col = 0; col < c.columns; col += 1) {
        const i = r * c.columns + col;
        this.#px[i] = col * c.spacing;
        this.#py[i] = r * c.spacing;
        this.#pz[i] = (nextUnit() - 0.5) * 2 * c.perturbation;
      }
    }
    const diag = c.spacing * Math.SQRT2;
    const pairs: Array<[number, number, number]> = [];
    for (let r = 0; r < c.rows; r += 1) {
      for (let col = 0; col < c.columns; col += 1) {
        const i = r * c.columns + col;
        if (col + 1 < c.columns) pairs.push([i, i + 1, c.spacing]);
        if (r + 1 < c.rows) pairs.push([i, i + c.columns, c.spacing]);
        if (col + 1 < c.columns && r + 1 < c.rows) {
          pairs.push([i, i + c.columns + 1, diag]);
          pairs.push([i + 1, i + c.columns, diag]);
        }
      }
    }
    this.#ca = new Int32Array(pairs.length); this.#cb = new Int32Array(pairs.length);
    this.#rest = new Float64Array(pairs.length);
    pairs.forEach(([a, b, rest], k) => { this.#ca[k] = a; this.#cb[k] = b; this.#rest[k] = rest; });
    this.#order = new Uint32Array(coloring.order);
    for (const [col, row] of PINNED) this.#setPinned(col, row);
  }
  #setPinned(col: number, row: number): void {
    const i = row * GRID.columns + col;
    this.#invMass[i] = 0;
    this.#vx[i] = 0; this.#vy[i] = 0; this.#vz[i] = 0;
  }
  /** 单子步(tick 时间基仅风使用,本场景无风;与 ClothSolver.stepSubstep 逐式同构,仅约束批序不同)。 */
  stepSubstep(): void {
    const c = GRID;
    const h = c.dtSeconds / c.substeps;
    const dampingScale = 1 - c.damping * h;
    const px = this.#px; const py = this.#py; const pz = this.#pz;
    const vx = this.#vx; const vy = this.#vy; const vz = this.#vz;
    const qx = this.#qx; const qy = this.#qy; const qz = this.#qz;
    const invMass = this.#invMass;
    this.#qx.set(px); this.#qy.set(py); this.#qz.set(pz);
    for (let i = 0; i < this.#count; i += 1) {
      if (invMass[i] === 0) continue;
      vx[i] = (vx[i]! + c.gravity[0] * h) * dampingScale;
      vy[i] = (vy[i]! + c.gravity[1] * h) * dampingScale;
      vz[i] = (vz[i]! + c.gravity[2] * h) * dampingScale;
      px[i] = px[i]! + vx[i]! * h; py[i] = py[i]! + vy[i]! * h; pz[i] = pz[i]! + vz[i]! * h;
    }
    goldenContactsProject(px, py, pz, invMass);
    const alphaTilde = c.compliance / (h * h);
    // 唯一差异:约束循环按色桶序(而非构建序)。
    const lambda = new Float64Array(this.#rest.length);
    for (let bucket = 0; bucket < this.#order.length; bucket += 1) {
      const k = this.#order[bucket]!;
      const a = this.#ca[k]!; const b = this.#cb[k]!;
      const wa = invMass[a]!; const wb = invMass[b]!;
      const denom = wa + wb;
      if (denom === 0) continue;
      const dx = px[a]! - px[b]!; const dy = py[a]! - py[b]!; const dz = pz[a]! - pz[b]!;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len === 0) continue;
      const l = (this.#rest[k]! - len - alphaTilde * lambda[k]!) / (denom + alphaTilde);
      lambda[k] = lambda[k]! + l;
      const nx = dx / len; const ny = dy / len; const nz = dz / len;
      px[a] = px[a]! + wa * l * nx; py[a] = py[a]! + wa * l * ny; pz[a] = pz[a]! + wa * l * nz;
      px[b] = px[b]! - wb * l * nx; py[b] = py[b]! - wb * l * ny; pz[b] = pz[b]! - wb * l * nz;
    }
    goldenContactsProject(px, py, pz, invMass);
    const invH = 1 / h;
    for (let i = 0; i < this.#count; i += 1) {
      if (invMass[i] === 0) { vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
      vx[i] = (px[i]! - qx[i]!) * invH;
      vy[i] = (py[i]! - qy[i]!) * invH;
      vz[i] = (pz[i]! - qz[i]!) * invH;
    }
  }
  positions(): { px: Float64Array; py: Float64Array; pz: Float64Array } {
    return { px: this.#px, py: this.#py, pz: this.#pz };
  }
  /** 1-ULP 扰动克隆:同构造新实例(确定性初态)后整状态拷贝,再对指定粒子 x ± n ULP。 */
  perturbClone(coloring: ClothColoring, index: number, ulps: number): ClothSolverColorOrder {
    const clone = new ClothSolverColorOrder(coloring);
    const target = clone.positions();
    const src = this.positions();
    target.px.set(src.px); target.py.set(src.py); target.pz.set(src.pz);
    target.px[index] = bumpUlps(src.px[index]!, ulps);
    clone.copyDerivedFrom(this);
    return clone;
  }
  /** 克隆辅助:拷贝速度/辅助缓冲(同类实例互访私有)。 */
  private copyDerivedFrom(src: ClothSolverColorOrder): void {
    this.#vx.set(src.#vx); this.#vy.set(src.#vy); this.#vz.set(src.#vz);
    this.#qx.set(src.#qx); this.#qy.set(src.#qy); this.#qz.set(src.#qz);
  }
}
