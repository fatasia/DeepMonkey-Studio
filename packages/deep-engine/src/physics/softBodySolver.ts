/**
 * T18 切片 1:软体 CPU 参考求解器(四面体质点体,XPBD 体积守恒约束)。
 *
 * 范围与如实声明:约束求解 + 重力 + 锚点;碰撞/自碰撞/Rapier 接线留后续子任务。
 * 每个四面体一个体积约束 C = V − V0(∇ 为棱叉积梯度),叠加唯一化的边距离约束
 * 抗剪切;compliance=0 时两类约束均为刚性。全部 f64、固定遍历序,无随机源。
 * 输入四面体环绕方向不要求一致:构建期把负体积四元组规整为正环绕(确定性)。
 *
 * sourceSizeGate 拆分(2026-10-03):合同类型(SoftBodySolverConfig/SoftBodySnapshot/
 * VolumeStats)移至 softBodySolverContract.ts,代码逐行同源仅改可见性,语义零变化;
 * 本文件原样再导出合同面,消费方导入路径不变。
 */
import { createSoftBodySelfCollision, extractSoftBodySurfaceTopology, type SoftBodySelfCollisionResolver } from "./softBodySelfCollision.js";
import { assertFinite, type FixedStepSim } from "./physicsTypes.js";
import type { SoftBodySolverConfig, SoftBodySnapshot, VolumeStats } from "./softBodySolverContract.js";

export type { SoftBodySolverConfig, SoftBodySnapshot, VolumeStats };

export class SoftBodySolver implements FixedStepSim<SoftBodySnapshot> {
  readonly #count: number;
  readonly #px: Float64Array;
  readonly #py: Float64Array;
  readonly #pz: Float64Array;
  readonly #vx: Float64Array;
  readonly #vy: Float64Array;
  readonly #vz: Float64Array;
  readonly #invMass: Float64Array;
  readonly #qx: Float64Array;
  readonly #qy: Float64Array;
  readonly #qz: Float64Array;
  readonly #tets: Int32Array;
  readonly #restVolume: Float64Array;
  readonly #edges: Int32Array;
  readonly #edgeRest: Float64Array;
  readonly #lambdaVol: Float64Array;
  readonly #lambdaEdge: Float64Array;
  readonly #selfCollision: SoftBodySelfCollisionResolver | null;
  /** 体积约束梯度工作缓冲(每 tick 复用,零热路径分配)。 */
  readonly #gx = new Float64Array(4);
  readonly #gy = new Float64Array(4);
  readonly #gz = new Float64Array(4);
  readonly #cfg: Omit<SoftBodySolverConfig, "positions" | "tets" | "pinned">;
  #tick = 0;

  constructor(config: SoftBodySolverConfig) {
    const { positions, tets, pinned, ...rest } = config;
    if (positions.length < 4) throw new Error(`SoftBodySolver: need >= 4 vertices, got ${positions.length}.`);
    if (!Number.isSafeInteger(tets.length) || tets.length < 1) throw new Error("SoftBodySolver: need at least one tetrahedron.");
    if (!(config.mass > 0) || !(config.dtSeconds > 0) || !Number.isSafeInteger(config.substeps) || config.substeps < 1) {
      throw new Error("SoftBodySolver: mass/dtSeconds must be positive and substeps an integer >= 1.");
    }
    if (!config.gravity.every(Number.isFinite)) throw new Error("SoftBodySolver: gravity must be finite.");
    this.#cfg = rest;
    this.#count = positions.length;
    const n = this.#count;
    this.#px = new Float64Array(n); this.#py = new Float64Array(n); this.#pz = new Float64Array(n);
    this.#vx = new Float64Array(n); this.#vy = new Float64Array(n); this.#vz = new Float64Array(n);
    this.#qx = new Float64Array(n); this.#qy = new Float64Array(n); this.#qz = new Float64Array(n);
    this.#invMass = new Float64Array(n).fill(1 / config.mass);
    for (const i of pinned) {
      if (!Number.isSafeInteger(i) || i < 0 || i >= n) throw new Error(`SoftBodySolver: pinned index ${i} out of range [0,${n}).`);
      this.#invMass[i] = 0;
    }
    for (let i = 0; i < n; i += 1) {
      const p = positions[i]!;
      if (!p || p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`SoftBodySolver: vertex ${i} must be 3 finite numbers.`);
      this.#px[i] = p[0]; this.#py[i] = p[1]; this.#pz[i] = p[2];
    }
    this.#tets = new Int32Array(tets.length * 4);
    this.#restVolume = new Float64Array(tets.length);
    this.#lambdaVol = new Float64Array(tets.length);
    for (let t = 0; t < tets.length; t += 1) {
      const [i0, i1, i2, i3] = tets[t]!;
      for (const i of [i0, i1, i2, i3]) {
        if (!Number.isSafeInteger(i) || i < 0 || i >= n) throw new Error(`SoftBodySolver: tet ${t} references vertex ${i} out of range.`);
      }
      const v = this.#signedVolume(i0, i1, i2, i3);
      if (v === 0) throw new Error(`SoftBodySolver: tet ${t} is degenerate (zero volume); fix input geometry.`);
      // 环绕规整:负体积交换中间两个索引,统一为正环绕(确定性,不改变几何)。
      if (v > 0) {
        this.#tets.set([i0, i1, i2, i3], t * 4);
        this.#restVolume[t] = v;
      } else {
        this.#tets.set([i0, i2, i1, i3], t * 4);
        this.#restVolume[t] = -v;
      }
    }
    // 唯一边集合(键 = a·n + b,首次出现保留;遍历序固定)。
    const seen = new Set<number>();
    const edgeList: number[] = [];
    for (let t = 0; t < tets.length; t += 1) {
      const ids = [this.#tets[4 * t]!, this.#tets[4 * t + 1]!, this.#tets[4 * t + 2]!, this.#tets[4 * t + 3]!];
      for (let a = 0; a < 4; a += 1) {
        for (let b = a + 1; b < 4; b += 1) {
          const lo = Math.min(ids[a]!, ids[b]!); const hi = Math.max(ids[a]!, ids[b]!);
          const key = lo * n + hi;
          if (seen.has(key)) continue;
          seen.add(key);
          edgeList.push(lo, hi);
        }
      }
    }
    this.#edges = new Int32Array(edgeList);
    this.#edgeRest = new Float64Array(edgeList.length / 2);
    this.#lambdaEdge = new Float64Array(edgeList.length / 2);
    for (let e = 0; e < this.#edgeRest.length; e += 1) {
      const a = this.#edges[2 * e]!; const b = this.#edges[2 * e + 1]!;
      this.#edgeRest[e] = Math.hypot(this.#px[a]! - this.#px[b]!, this.#py[a]! - this.#py[b]!, this.#pz[a]! - this.#pz[b]!);
      if (!(this.#edgeRest[e]! > 0)) throw new Error(`SoftBodySolver: edge ${e} has zero rest length (duplicate vertex positions ${a}/${b}).`);
    }
    if (config.selfCollisionRadius !== undefined) {
      const radius = config.selfCollisionRadius;
      const minEdge = Math.min(...Array.from(this.#edgeRest));
      this.#selfCollision = createSoftBodySelfCollision({
        topology: extractSoftBodySurfaceTopology(tets, n),
        count: n, radius, minEdgeLength: minEdge,
      });
    } else {
      this.#selfCollision = null;
    }
  }

  get tick(): number { return this.#tick; }
  get tetCount(): number { return this.#restVolume.length; }
  positions(): Float64Array { return this.#px; }
  /** xyz 交错位置拷贝(渲染消费;F6 运行会话 readout 走此形态)。 */
  positionsInterleaved(): Float64Array {
    const out = new Float64Array(this.#count * 3);
    for (let i = 0; i < this.#count; i += 1) {
      out[i * 3] = this.#px[i]!; out[i * 3 + 1] = this.#py[i]!; out[i * 3 + 2] = this.#pz[i]!;
    }
    return out;
  }

  #signedVolume(i0: number, i1: number, i2: number, i3: number): number {
    const ax = this.#px[i0]! - this.#px[i3]!; const ay = this.#py[i0]! - this.#py[i3]!; const az = this.#pz[i0]! - this.#pz[i3]!;
    const bx = this.#px[i1]! - this.#px[i3]!; const by = this.#py[i1]! - this.#py[i3]!; const bz = this.#pz[i1]! - this.#pz[i3]!;
    const cx = this.#px[i2]! - this.#px[i3]!; const cy = this.#py[i2]! - this.#py[i3]!; const cz = this.#pz[i2]! - this.#pz[i3]!;
    const crossX = by * cz - bz * cy;
    const crossY = bz * cx - bx * cz;
    const crossZ = bx * cy - by * cx;
    return (ax * crossX + ay * crossY + az * crossZ) / 6;
  }

  /** 当前各四面体有符号体积(环绕已规整为正)。 */
  tetVolumes(): Float64Array {
    const out = new Float64Array(this.#restVolume.length);
    for (let t = 0; t < out.length; t += 1) {
      out[t] = this.#signedVolume(this.#tets[4 * t]!, this.#tets[4 * t + 1]!, this.#tets[4 * t + 2]!, this.#tets[4 * t + 3]!);
    }
    return out;
  }

  /** 体积误差统计(验收指标:≤5% 目标体积)。 */
  measureVolumeError(): VolumeStats {
    const volumes = this.tetVolumes();
    let max = 0; let total = 0; let restTotal = 0;
    for (let t = 0; t < volumes.length; t += 1) {
      const ratio = Math.abs(volumes[t]! - this.#restVolume[t]!) / this.#restVolume[t]!;
      if (ratio > max) max = ratio;
      total += volumes[t]!; restTotal += this.#restVolume[t]!;
    }
    return { maxTetRatio: max, totalRatio: Math.abs(total - restTotal) / restTotal, tetCount: volumes.length };
  }

  step(): void {
    for (let sub = 0; sub < this.#cfg.substeps; sub += 1) this.stepSubstep(sub);
    this.#tick += 1;
    assertFinite(this.#px, "softbody.px"); assertFinite(this.#py, "softbody.py"); assertFinite(this.#pz, "softbody.pz");
  }

  /** 内部缓冲只读引用(会话级跨软体互碰投影消费;调用方不得写入)。 */
  particleBuffers(): { px: Float64Array; py: Float64Array; pz: Float64Array; inverseMass: Float64Array; count: number } {
    return { px: this.#px, py: this.#py, pz: this.#pz, inverseMass: this.#invMass, count: this.#count };
  }

  /** 单子步(互碰会话的子步级编排消费);tick 计数与 finite 审计仍属 step()。 */
  stepSubstep(substep: number): void {
    const c = this.#cfg;
    const h = c.dtSeconds / c.substeps;
    const dampingScale = 1 - c.damping * h;
    const alphaEdge = c.complianceDistance / (h * h);
    const alphaVol = c.complianceVolume / (h * h);
    const px = this.#px; const py = this.#py; const pz = this.#pz;
    const vx = this.#vx; const vy = this.#vy; const vz = this.#vz;
    const qx = this.#qx; const qy = this.#qy; const qz = this.#qz;
    const invMass = this.#invMass;
    void substep; // 软体无风场,时间基不进入子步体;签名与 ClothSolver 对齐。
    this.#qx.set(this.#px); this.#qy.set(this.#py); this.#qz.set(this.#pz);
    const groundY = c.groundY;
    for (let i = 0; i < this.#count; i += 1) {
      if (invMass[i] === 0) continue;
      vx[i] = (vx[i]! + c.gravity[0] * h) * dampingScale;
      vy[i] = (vy[i]! + c.gravity[1] * h) * dampingScale;
      vz[i] = (vz[i]! + c.gravity[2] * h) * dampingScale;
      px[i] = px[i]! + vx[i]! * h; py[i] = py[i]! + vy[i]! * h; pz[i] = pz[i]! + vz[i]! * h;
      // 地面接触:积分后位置投影;速度由 (p−q)/h 回算自然消去法向分量。
      if (groundY !== undefined && py[i]! < groundY) py[i] = groundY;
    }
    c.contacts?.project(px, py, pz, invMass, c.groundY);
    this.#selfCollision?.resolve(px, py, pz, invMass);
    this.#lambdaEdge.fill(0); this.#lambdaVol.fill(0);
    for (let e = 0; e < this.#edgeRest.length; e += 1) this.#projectEdge(e, alphaEdge);
    for (let t = 0; t < this.#restVolume.length; t += 1) this.#projectVolume(t, alphaVol);
    // 约束投影可能把粒子再次推到地面下;速度回算前再钳制一次。
    if (c.groundY !== undefined) {
      for (let i = 0; i < this.#count; i += 1) {
        if (this.#invMass[i] !== 0 && py[i]! < c.groundY) py[i] = c.groundY;
      }
    }
    c.contacts?.project(px, py, pz, invMass, c.groundY);
    this.#selfCollision?.resolve(px, py, pz, invMass);
    const invH = 1 / h;
    for (let i = 0; i < this.#count; i += 1) {
      if (invMass[i] === 0) { vx[i] = 0; vy[i] = 0; vz[i] = 0; continue; }
      vx[i] = (px[i]! - qx[i]!) * invH;
      vy[i] = (py[i]! - qy[i]!) * invH;
      vz[i] = (pz[i]! - qz[i]!) * invH;
    }
  }

  #projectEdge(e: number, alphaTilde: number): void {
    const a = this.#edges[2 * e]!; const b = this.#edges[2 * e + 1]!;
    const wa = this.#invMass[a]!; const wb = this.#invMass[b]!;
    const denom = wa + wb;
    if (denom === 0) return;
    const dx = this.#px[a]! - this.#px[b]!; const dy = this.#py[a]! - this.#py[b]!; const dz = this.#pz[a]! - this.#pz[b]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len === 0) return;
    const lambda = (this.#edgeRest[e]! - len - alphaTilde * this.#lambdaEdge[e]!) / (denom + alphaTilde);
    this.#lambdaEdge[e] = this.#lambdaEdge[e]! + lambda;
    const nx = dx / len; const ny = dy / len; const nz = dz / len;
    this.#px[a] = this.#px[a]! + wa * lambda * nx; this.#py[a] = this.#py[a]! + wa * lambda * ny; this.#pz[a] = this.#pz[a]! + wa * lambda * nz;
    this.#px[b] = this.#px[b]! - wb * lambda * nx; this.#py[b] = this.#py[b]! - wb * lambda * ny; this.#pz[b] = this.#pz[b]! - wb * lambda * nz;
  }

  /** XPBD 体积约束:∇_{p0..2} = 叉积/6,∇_{p3} = −Σ∇;Δp = Δλ·w·∇。 */
  #projectVolume(t: number, alphaTilde: number): void {
    const [i0, i1, i2, i3] = [this.#tets[4 * t]!, this.#tets[4 * t + 1]!, this.#tets[4 * t + 2]!, this.#tets[4 * t + 3]!];
    const gx = this.#gx; const gy = this.#gy; const gz = this.#gz;
    const e1x = this.#px[i1]! - this.#px[i3]!; const e1y = this.#py[i1]! - this.#py[i3]!; const e1z = this.#pz[i1]! - this.#pz[i3]!;
    const e2x = this.#px[i2]! - this.#px[i3]!; const e2y = this.#py[i2]! - this.#py[i3]!; const e2z = this.#pz[i2]! - this.#pz[i3]!;
    // ∇_{p0} = (p1−p3)×(p2−p3)/6
    gx[0] = (e1y * e2z - e1z * e2y) / 6; gy[0] = (e1z * e2x - e1x * e2z) / 6; gz[0] = (e1x * e2y - e1y * e2x) / 6;
    // ∇_{p1} = (p2−p3)×(p0−p3)/6
    const f1x = this.#px[i2]! - this.#px[i3]!; const f1y = this.#py[i2]! - this.#py[i3]!; const f1z = this.#pz[i2]! - this.#pz[i3]!;
    const f2x = this.#px[i0]! - this.#px[i3]!; const f2y = this.#py[i0]! - this.#py[i3]!; const f2z = this.#pz[i0]! - this.#pz[i3]!;
    gx[1] = (f1y * f2z - f1z * f2y) / 6; gy[1] = (f1z * f2x - f1x * f2z) / 6; gz[1] = (f1x * f2y - f1y * f2x) / 6;
    // ∇_{p2} = (p0−p3)×(p1−p3)/6
    const h1x = this.#px[i0]! - this.#px[i3]!; const h1y = this.#py[i0]! - this.#py[i3]!; const h1z = this.#pz[i0]! - this.#pz[i3]!;
    const h2x = this.#px[i1]! - this.#px[i3]!; const h2y = this.#py[i1]! - this.#py[i3]!; const h2z = this.#pz[i1]! - this.#pz[i3]!;
    gx[2] = (h1y * h2z - h1z * h2y) / 6; gy[2] = (h1z * h2x - h1x * h2z) / 6; gz[2] = (h1x * h2y - h1y * h2x) / 6;
    gx[3] = -(gx[0]! + gx[1]! + gx[2]!); gy[3] = -(gy[0]! + gy[1]! + gy[2]!); gz[3] = -(gz[0]! + gz[1]! + gz[2]!);
    let denomW = 0;
    const ws = [this.#invMass[i0]!, this.#invMass[i1]!, this.#invMass[i2]!, this.#invMass[i3]!];
    for (let i = 0; i < 4; i += 1) denomW += ws[i]! * (gx[i]! * gx[i]! + gy[i]! * gy[i]! + gz[i]! * gz[i]!);
    if (denomW === 0) return;
    const volume = this.#signedVolume(i0, i1, i2, i3);
    const lambda = (this.#restVolume[t]! - volume - alphaTilde * this.#lambdaVol[t]!) / (denomW + alphaTilde);
    this.#lambdaVol[t] = this.#lambdaVol[t]! + lambda;
    const idx = [i0, i1, i2, i3];
    for (let i = 0; i < 4; i += 1) {
      const target = idx[i]!;
      const scale = ws[i]! * lambda;
      this.#px[target] = this.#px[target]! + scale * gx[i]!;
      this.#py[target] = this.#py[target]! + scale * gy[i]!;
      this.#pz[target] = this.#pz[target]! + scale * gz[i]!;
    }
  }

  capture(): SoftBodySnapshot {
    return {
      tick: this.#tick,
      px: new Float64Array(this.#px), py: new Float64Array(this.#py), pz: new Float64Array(this.#pz),
      vx: new Float64Array(this.#vx), vy: new Float64Array(this.#vy), vz: new Float64Array(this.#vz),
    };
  }

  restore(snapshot: SoftBodySnapshot): void {
    this.#px.set(snapshot.px); this.#py.set(snapshot.py); this.#pz.set(snapshot.pz);
    this.#vx.set(snapshot.vx); this.#vy.set(snapshot.vy); this.#vz.set(snapshot.vz);
    this.#tick = snapshot.tick;
  }
}
