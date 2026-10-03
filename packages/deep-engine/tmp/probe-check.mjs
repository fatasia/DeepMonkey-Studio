var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/physics/clothConstraintColoring.ts
var clothConstraintColoring_exports = {};
__export(clothConstraintColoring_exports, {
  assertColoringValid: () => assertColoringValid,
  colorClothConstraints: () => colorClothConstraints
});
function colorClothConstraints(a, b, particleCount) {
  if (a.length !== b.length) throw new Error("cloth coloring: constraint endpoint arrays must have equal length.");
  const degree = new Uint32Array(particleCount);
  for (let k = 0; k < a.length; k += 1) {
    degree[a[k]] += 1;
    degree[b[k]] += 1;
  }
  let maxDegree = 0;
  for (let i = 0; i < particleCount; i += 1) if (degree[i] > maxDegree) maxDegree = degree[i];
  const colors = new Uint16Array(a.length);
  const used = new Array(particleCount);
  for (let i = 0; i < particleCount; i += 1) used[i] = new Uint32Array(1);
  let colorCount = 0;
  for (let k = 0; k < a.length; k += 1) {
    const endpointA = a[k];
    const endpointB = b[k];
    if (endpointA === endpointB) throw new Error(`cloth coloring: constraint ${k} is degenerate (a === b).`);
    const forbidden = used[endpointA][0] | used[endpointB][0];
    let color = 0;
    while (color < 32 && (forbidden & 1 << color) !== 0) color += 1;
    if (color >= 32) throw new Error(`cloth coloring: constraint ${k} needs a color >= 32 (degree overflow; fail-closed).`);
    colors[k] = color;
    if (color + 1 > colorCount) colorCount = color + 1;
    used[endpointA][0] |= 1 << color;
    used[endpointB][0] |= 1 << color;
  }
  const bucketSize = new Uint32Array(colorCount);
  for (let k = 0; k < a.length; k += 1) bucketSize[colors[k]] += 1;
  const bucketStart = new Uint32Array(colorCount);
  let cursor = 0;
  for (let c = 0; c < colorCount; c += 1) {
    bucketStart[c] = cursor;
    cursor += bucketSize[c];
  }
  const order = new Uint32Array(a.length);
  const fill = Uint32Array.from(bucketStart);
  for (let k = 0; k < a.length; k += 1) order[fill[colors[k]]++] = k;
  const colorRanges = [];
  for (let c = 0; c < colorCount; c += 1) colorRanges.push([bucketStart[c], bucketStart[c] + bucketSize[c]]);
  return { colors, colorCount, order, colorRanges, maxDegree };
}
function assertColoringValid(coloring, a, b) {
  const seen = /* @__PURE__ */ new Set();
  for (let c = 0; c < coloring.colorCount; c += 1) {
    seen.clear();
    for (let i = coloring.colorRanges[c][0]; i < coloring.colorRanges[c][1]; i += 1) {
      const k = coloring.order[i];
      for (const endpoint of [a[k], b[k]]) {
        if (seen.has(endpoint)) throw new Error(`cloth coloring: color ${c} shares particle ${endpoint} across constraints.`);
        seen.add(endpoint);
      }
    }
  }
}
var init_clothConstraintColoring = __esm({
  "src/physics/clothConstraintColoring.ts"() {
    "use strict";
  }
});

// src/terrain/terrainRandom.ts
function hashGrid2D(x, z, seed) {
  let h = Math.imul(x | 0, 668265261) ^ Math.imul(z | 0, 374761393) ^ Math.imul(seed | 0, 2654435769);
  h = Math.imul(h ^ h >>> 15, 739982445);
  h = Math.imul(h ^ h >>> 12, 695872825);
  h ^= h >>> 15;
  return h >>> 0;
}
function smoothQuintic(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function createValueNoise2D(seed) {
  return (x, z) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const tx = x - xi;
    const tz = z - zi;
    const sx = smoothQuintic(tx);
    const sz = smoothQuintic(tz);
    const v00 = hashGrid2D(xi, zi, seed) * INV_UINT32;
    const v10 = hashGrid2D(xi + 1, zi, seed) * INV_UINT32;
    const v01 = hashGrid2D(xi, zi + 1, seed) * INV_UINT32;
    const v11 = hashGrid2D(xi + 1, zi + 1, seed) * INV_UINT32;
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sz;
  };
}
var INV_UINT32;
var init_terrainRandom = __esm({
  "src/terrain/terrainRandom.ts"() {
    "use strict";
    INV_UINT32 = 1 / 4294967296;
  }
});

// src/physics/clothSelfCollision.ts
function bucketOf(cx, cy, cz) {
  let h = Math.imul(cx, 2376512323) ^ Math.imul(cy, 3625334849) ^ Math.imul(cz, 3407524639);
  h ^= h >>> 15;
  return h & BUCKET_COUNT - 1;
}
function createParticleSeparation(config) {
  const sets = config.sets;
  const diameter = config.diameter;
  if (sets.length < 1) throw new Error("ParticleSeparation: at least one set is required.");
  for (const set of sets) {
    if (!Number.isSafeInteger(set.count) || set.count < 1) {
      throw new Error(`ParticleSeparation: set count must be an integer >= 1, got ${set.count}.`);
    }
  }
  if (!(diameter > 0) || !Number.isFinite(diameter)) {
    throw new Error(`ParticleSeparation: diameter must be positive finite, got ${config.diameter}.`);
  }
  const crossOnly = config.crossOnly;
  const total = sets.reduce((sum, set) => sum + set.count, 0);
  const cell = diameter;
  const invCell = 1 / cell;
  const diameterSq = diameter * diameter;
  const bucketStart = new Int32Array(BUCKET_COUNT + 1);
  const order = new Int32Array(total);
  const bucketOfParticle = new Int32Array(total);
  const cellX = new Int32Array(total);
  const cellY = new Int32Array(total);
  const cellZ = new Int32Array(total);
  const setIndex = new Int32Array(total);
  const particleIndex = new Int32Array(total);
  return { resolve() {
    for (const set of sets) {
      if (set.px.length < set.count || set.py.length < set.count || set.pz.length < set.count || set.inverseMass.length < set.count) {
        throw new Error("ParticleSeparation: set buffers must cover count particles.");
      }
    }
    let flat = 0;
    bucketStart.fill(0);
    for (let s = 0; s < sets.length; s += 1) {
      const set = sets[s];
      for (let i = 0; i < set.count; i += 1) {
        const cx = Math.floor(set.px[i] * invCell);
        const cy = Math.floor(set.py[i] * invCell);
        const cz = Math.floor(set.pz[i] * invCell);
        cellX[flat] = cx;
        cellY[flat] = cy;
        cellZ[flat] = cz;
        setIndex[flat] = s;
        particleIndex[flat] = i;
        const b = bucketOf(cx, cy, cz);
        bucketOfParticle[flat] = b;
        bucketStart[b] = bucketStart[b] + 1;
        flat += 1;
      }
    }
    let prefix = 0;
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      const c = bucketStart[b];
      bucketStart[b] = prefix;
      prefix += c;
    }
    bucketStart[BUCKET_COUNT] = prefix;
    for (let f2 = 0; f2 < total; f2 += 1) {
      order[bucketStart[bucketOfParticle[f2]]] = f2;
      bucketStart[bucketOfParticle[f2]] += 1;
    }
    let previous = 0;
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      const end = bucketStart[b];
      bucketStart[b] = previous;
      previous = end;
    }
    for (let f2 = 0; f2 < total; f2 += 1) {
      const setA = sets[setIndex[f2]];
      const i = particleIndex[f2];
      if (setA.inverseMass[i] === 0) continue;
      const ci = cellX[f2];
      const cy = cellY[f2];
      const cz = cellZ[f2];
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const b = bucketOf(ci + dx, cy + dy, cz + dz);
            const end = bucketStart[b + 1];
            for (let idx = bucketStart[b]; idx < end; idx += 1) {
              const g = order[idx];
              if (g <= f2) continue;
              const setB = sets[setIndex[g]];
              if (crossOnly && setB === setA) continue;
              const j = particleIndex[g];
              if (setB.inverseMass[j] === 0) continue;
              if (setB === setA && setA.skipPair && setA.skipPair(i, j)) continue;
              if (cellX[g] !== ci + dx || cellY[g] !== cy + dy || cellZ[g] !== cz + dz) continue;
              const ddx = setA.px[i] - setB.px[j];
              const ddy = setA.py[i] - setB.py[j];
              const ddz = setA.pz[i] - setB.pz[j];
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 >= diameterSq) continue;
              const wi = setA.inverseMass[i];
              const wj = setB.inverseMass[j];
              const denom = wi + wj;
              if (denom === 0) continue;
              if (d2 === 0) {
                setA.px[i] = setA.px[i] - wi * diameter / denom;
                setB.px[j] = setB.px[j] + wj * diameter / denom;
                continue;
              }
              const len = Math.sqrt(d2);
              const push = (diameter - len) / len / denom;
              setA.px[i] = setA.px[i] + ddx * push * wi;
              setA.py[i] = setA.py[i] + ddy * push * wi;
              setA.pz[i] = setA.pz[i] + ddz * push * wi;
              setB.px[j] = setB.px[j] - ddx * push * wj;
              setB.py[j] = setB.py[j] - ddy * push * wj;
              setB.pz[j] = setB.pz[j] - ddz * push * wj;
            }
          }
        }
      }
    }
  } };
}
function createClothSelfCollision(config) {
  const count = config.count;
  const radius = config.radius;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`ClothSelfCollision: count must be an integer >= 1, got ${config.count}.`);
  }
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`ClothSelfCollision: radius must be positive finite, got ${config.radius}.`);
  }
  const buffers = {
    px: new Float64Array(0),
    py: new Float64Array(0),
    pz: new Float64Array(0),
    inverseMass: new Float64Array(0),
    count
  };
  const separation = createParticleSeparation({ sets: [buffers], diameter: 2 * radius, crossOnly: false });
  return { resolve(px, py, pz, inverseMass) {
    buffers.px = px;
    buffers.py = py;
    buffers.pz = pz;
    buffers.inverseMass = inverseMass;
    separation.resolve();
  } };
}
var BUCKET_BITS, BUCKET_COUNT;
var init_clothSelfCollision = __esm({
  "src/physics/clothSelfCollision.ts"() {
    "use strict";
    BUCKET_BITS = 12;
    BUCKET_COUNT = 1 << BUCKET_BITS;
  }
});

// src/physics/physicsTypes.ts
function assertFinite(values, label) {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      throw new Error(`${label}[${i}] became non-finite (${v}); solver diverged.`);
    }
  }
}
var init_physicsTypes = __esm({
  "src/physics/physicsTypes.ts"() {
    "use strict";
  }
});

// src/physics/clothSolver.ts
var clothSolver_exports = {};
__export(clothSolver_exports, {
  ClothSolver: () => ClothSolver
});
var WIND_NOISE_SALT, ClothSolver;
var init_clothSolver = __esm({
  "src/physics/clothSolver.ts"() {
    "use strict";
    init_terrainRandom();
    init_clothSelfCollision();
    init_physicsTypes();
    WIND_NOISE_SALT = 1374496513;
    ClothSolver = class {
      #cfg;
      #count;
      #px;
      #py;
      #pz;
      #vx;
      #vy;
      #vz;
      #invMass;
      /** 子步起点位置(q = p_prev),速度回算 v = (p − q)/h。 */
      #qx;
      #qy;
      #qz;
      /** 约束端点与解析静止长度;构建顺序 (row,col) 固定,遍历序即确定性序。 */
      #ca;
      #cb;
      #rest;
      #lambda;
      #noise;
      #selfCollision;
      #tick = 0;
      constructor(config) {
        const c = config;
        if (!Number.isSafeInteger(c.columns) || c.columns < 2 || !Number.isSafeInteger(c.rows) || c.rows < 2) {
          throw new Error(`ClothSolver: columns/rows must be integers >= 2, got ${c.columns}x${c.rows}.`);
        }
        if (!(c.spacing > 0) || !(c.mass > 0) || !(c.dtSeconds > 0) || !Number.isFinite(c.dtSeconds)) {
          throw new Error("ClothSolver: spacing, mass and dtSeconds must be positive finite numbers.");
        }
        if (!Number.isSafeInteger(c.substeps) || c.substeps < 1) throw new Error(`ClothSolver: substeps must be an integer >= 1, got ${c.substeps}.`);
        if (!(c.compliance >= 0) || !(c.damping >= 0) || c.damping >= 1 || !(c.perturbation >= 0)) {
          throw new Error("ClothSolver: compliance/perturbation must be >= 0 and damping in [0,1).");
        }
        if (!c.gravity.every(Number.isFinite)) throw new Error("ClothSolver: gravity must be finite.");
        this.#cfg = c;
        if (c.selfCollisionRadius !== void 0) {
          const r = c.selfCollisionRadius;
          if (!(r > 0) || !Number.isFinite(r) || 2 * r > c.spacing) {
            throw new Error(`ClothSolver: selfCollisionRadius must be positive finite with 2r <= spacing (${c.spacing}), got ${r}.`);
          }
          this.#selfCollision = createClothSelfCollision({ count: c.columns * c.rows, radius: r });
        } else {
          this.#selfCollision = null;
        }
        this.#count = c.columns * c.rows;
        const n = this.#count;
        this.#px = new Float64Array(n);
        this.#py = new Float64Array(n);
        this.#pz = new Float64Array(n);
        this.#vx = new Float64Array(n);
        this.#vy = new Float64Array(n);
        this.#vz = new Float64Array(n);
        this.#qx = new Float64Array(n);
        this.#qy = new Float64Array(n);
        this.#qz = new Float64Array(n);
        this.#invMass = new Float64Array(n).fill(1 / c.mass);
        this.#noise = createValueNoise2D(c.seed ^ WIND_NOISE_SALT | 0);
        let s = (c.seed | 0) + 2654435769 | 0;
        const nextUnit = () => {
          s = s + 1831565813 | 0;
          let t = s;
          t = Math.imul(t ^ t >>> 15, t | 1);
          t ^= t + Math.imul(t ^ t >>> 7, t | 61);
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
        for (let r = 0; r < c.rows; r += 1) {
          for (let col = 0; col < c.columns; col += 1) {
            const i = r * c.columns + col;
            const originX = c.origin?.[0] ?? 0;
            const originY = c.origin?.[1] ?? 0;
            const originZ = c.origin?.[2] ?? 0;
            this.#px[i] = originX + col * c.spacing;
            this.#py[i] = originY + r * c.spacing;
            this.#pz[i] = originZ + (c.perturbation > 0 ? (nextUnit() - 0.5) * 2 * c.perturbation : 0);
          }
        }
        const diag = c.spacing * Math.SQRT2;
        const pairs = [];
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
        this.#ca = new Int32Array(pairs.length);
        this.#cb = new Int32Array(pairs.length);
        this.#rest = new Float64Array(pairs.length);
        this.#lambda = new Float64Array(pairs.length);
        for (let k = 0; k < pairs.length; k += 1) {
          const [a, b, rest] = pairs[k];
          this.#ca[k] = a;
          this.#cb[k] = b;
          this.#rest[k] = rest;
        }
      }
      get tick() {
        return this.#tick;
      }
      get constraintCount() {
        return this.#rest.length;
      }
      particleIndex(col, row) {
        return row * this.#cfg.columns + col;
      }
      /** 位置 SoA 只读引用(内部缓冲;跨帧/跨会话消费请用 capture)。 */
      positions() {
        return this.#px;
      }
      /** xyz 交错位置拷贝(渲染消费;F6 运行会话 readout 走此形态)。 */
      positionsInterleaved() {
        const out = new Float64Array(this.#count * 3);
        for (let i = 0; i < this.#count; i += 1) {
          out[i * 3] = this.#px[i];
          out[i * 3 + 1] = this.#py[i];
          out[i * 3 + 2] = this.#pz[i];
        }
        return out;
      }
      /** 锚点:invMass=0 且速度清零;解绑恢复单位质量。 */
      setPinned(col, row, pinned) {
        const i = this.particleIndex(col, row);
        this.#invMass[i] = pinned ? 0 : 1 / this.#cfg.mass;
        if (pinned) {
          this.#vx[i] = 0;
          this.#vy[i] = 0;
          this.#vz[i] = 0;
        }
      }
      /** 锚点(运行包 pinned 粒子索引 = row·columns+col 直通形态)。 */
      setPinnedIndex(index, pinned = true) {
        const i = Math.floor(index / this.#cfg.columns);
        this.setPinned(index - i * this.#cfg.columns, i, pinned);
      }
      isPinned(col, row) {
        return this.#invMass[this.particleIndex(col, row)] === 0;
      }
      /** 拉伸误差统计(验收指标:收敛后 maxRatio ≤ 5% 目标约束长度)。 */
      measureStretch() {
        let max = 0;
        let sum = 0;
        for (let k = 0; k < this.#rest.length; k += 1) {
          const a = this.#ca[k];
          const b = this.#cb[k];
          const rest = this.#rest[k];
          const dx = this.#px[a] - this.#px[b];
          const dy = this.#py[a] - this.#py[b];
          const dz = this.#pz[a] - this.#pz[b];
          const ratio = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - rest) / rest;
          if (ratio > max) max = ratio;
          sum += ratio;
        }
        return { maxRatio: max, meanRatio: sum / this.#rest.length, constraintCount: this.#rest.length };
      }
      step() {
        for (let sub2 = 0; sub2 < this.#cfg.substeps; sub2 += 1) this.stepSubstep(sub2);
        this.#tick += 1;
        assertFinite(this.#px, "cloth.px");
        assertFinite(this.#py, "cloth.py");
        assertFinite(this.#pz, "cloth.pz");
      }
      /** 内部缓冲只读引用(会话级跨软体互碰投影消费;调用方不得写入)。 */
      particleBuffers() {
        return { px: this.#px, py: this.#py, pz: this.#pz, inverseMass: this.#invMass, count: this.#count };
      }
      /** 单子步(互碰会话的子步级编排消费);tick 计数与 finite 审计仍属 step()。
       * substep 是本 tick 内的子步序号,时间基与连续 step() 逐位一致。 */
      stepSubstep(substep) {
        const c = this.#cfg;
        const h = c.dtSeconds / c.substeps;
        const t = this.#tick * c.dtSeconds + substep * h;
        const dampingScale = 1 - c.damping * h;
        const alphaTilde = c.compliance / (h * h);
        const px = this.#px;
        const py = this.#py;
        const pz = this.#pz;
        const vx = this.#vx;
        const vy = this.#vy;
        const vz = this.#vz;
        const qx = this.#qx;
        const qy = this.#qy;
        const qz = this.#qz;
        const invMass = this.#invMass;
        this.#qx.set(this.#px);
        this.#qy.set(this.#py);
        this.#qz.set(this.#pz);
        const groundY = c.groundY;
        for (let i = 0; i < this.#count; i += 1) {
          if (invMass[i] === 0) continue;
          const w = this.windAcceleration(t, py[i]);
          vx[i] = (vx[i] + (c.gravity[0] + w[0]) * h) * dampingScale;
          vy[i] = (vy[i] + (c.gravity[1] + w[1]) * h) * dampingScale;
          vz[i] = (vz[i] + (c.gravity[2] + w[2]) * h) * dampingScale;
          px[i] = px[i] + vx[i] * h;
          py[i] = py[i] + vy[i] * h;
          pz[i] = pz[i] + vz[i] * h;
          if (groundY !== void 0 && py[i] < groundY) py[i] = groundY;
        }
        c.contacts?.project(px, py, pz, invMass, c.groundY);
        this.#selfCollision?.resolve(px, py, pz, invMass);
        this.#lambda.fill(0);
        for (let k = 0; k < this.#rest.length; k += 1) this.#project(k, alphaTilde);
        if (c.groundY !== void 0) {
          for (let i = 0; i < this.#count; i += 1) {
            if (this.#invMass[i] !== 0 && py[i] < c.groundY) py[i] = c.groundY;
          }
        }
        c.contacts?.project(px, py, pz, invMass, c.groundY);
        this.#selfCollision?.resolve(px, py, pz, invMass);
        const invH = 1 / h;
        for (let i = 0; i < this.#count; i += 1) {
          if (invMass[i] === 0) {
            vx[i] = 0;
            vy[i] = 0;
            vz[i] = 0;
            continue;
          }
          vx[i] = (px[i] - qx[i]) * invH;
          vy[i] = (py[i] - qy[i]) * invH;
          vz[i] = (pz[i] - qz[i]) * invH;
        }
      }
      /** XPBD 距离约束投影:Δλ = (−C − α̃λ)/(w1+w2+α̃);Δp = Δλ·w·∇C。 */
      #project(k, alphaTilde) {
        const a = this.#ca[k];
        const b = this.#cb[k];
        const wa = this.#invMass[a];
        const wb = this.#invMass[b];
        const denom = wa + wb;
        if (denom === 0) return;
        const dx = this.#px[a] - this.#px[b];
        const dy = this.#py[a] - this.#py[b];
        const dz = this.#pz[a] - this.#pz[b];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len === 0) return;
        const lambda = (this.#rest[k] - len - alphaTilde * this.#lambda[k]) / (denom + alphaTilde);
        this.#lambda[k] = this.#lambda[k] + lambda;
        const nx = dx / len;
        const ny = dy / len;
        const nz = dz / len;
        this.#px[a] = this.#px[a] + wa * lambda * nx;
        this.#py[a] = this.#py[a] + wa * lambda * ny;
        this.#pz[a] = this.#pz[a] + wa * lambda * nz;
        this.#px[b] = this.#px[b] - wb * lambda * nx;
        this.#py[b] = this.#py[b] - wb * lambda * ny;
        this.#pz[b] = this.#pz[b] - wb * lambda * nz;
      }
      windAcceleration(t, y) {
        const w = this.#cfg.wind;
        if (!w) return [0, 0, 0];
        const speed = w.baseSpeed * (0.5 + this.#noise(t * w.gustFrequency, y * w.spatialScale));
        return [w.direction[0] * speed, w.direction[1] * speed, w.direction[2] * speed];
      }
      capture() {
        return {
          tick: this.#tick,
          px: new Float64Array(this.#px),
          py: new Float64Array(this.#py),
          pz: new Float64Array(this.#pz),
          vx: new Float64Array(this.#vx),
          vy: new Float64Array(this.#vy),
          vz: new Float64Array(this.#vz)
        };
      }
      restore(snapshot) {
        this.#px.set(snapshot.px);
        this.#py.set(snapshot.py);
        this.#pz.set(snapshot.pz);
        this.#vx.set(snapshot.vx);
        this.#vy.set(snapshot.vy);
        this.#vz.set(snapshot.vz);
        this.#tick = snapshot.tick;
      }
    };
  }
});

// src/physics/softBodyGpuWgsl.ts
function packSoftBodyGpuParticles(particles) {
  const out = new Float32Array(particles.length * 12);
  particles.forEach((particle, index) => {
    validateParticle2(particle, index);
    const base = index * 12;
    out.set([...particle.position, particle.inverseMass], base);
    out.set([...particle.velocity, 0], base + 4);
    out.set([...particle.position, 0], base + 8);
  });
  return out;
}
function packSoftBodyGpuEdges(edges, particleCount) {
  const out = new ArrayBuffer(edges.length * SOFT_BODY_GPU_EDGE_STRIDE_BYTES);
  const view = new DataView(out);
  edges.forEach((edge, index) => {
    validateEdge(edge, index, particleCount);
    const offset = index * SOFT_BODY_GPU_EDGE_STRIDE_BYTES;
    view.setUint32(offset, edge.a, true);
    view.setUint32(offset + 4, edge.b, true);
    view.setFloat32(offset + 8, edge.restLength, true);
  });
  return out;
}
function packSoftBodyGpuTets(tets, particleCount) {
  const out = new ArrayBuffer(tets.length * SOFT_BODY_GPU_TET_STRIDE_BYTES);
  const view = new DataView(out);
  tets.forEach((tet, index) => {
    validateTet(tet, index, particleCount);
    const offset = index * SOFT_BODY_GPU_TET_STRIDE_BYTES;
    view.setUint32(offset, tet.i0, true);
    view.setUint32(offset + 4, tet.i1, true);
    view.setUint32(offset + 8, tet.i2, true);
    view.setUint32(offset + 12, tet.i3, true);
    view.setFloat32(offset + 16, tet.restVolume, true);
  });
  return out;
}
function packSoftBodyGpuParams(input) {
  validateStepInput2(input);
  const out = new ArrayBuffer(SOFT_BODY_GPU_PARAMS_BYTES);
  const integers = new Uint32Array(out);
  const floats = new Float32Array(out);
  integers[0] = input.particles.length;
  integers[1] = input.edges.length;
  integers[2] = input.tets.length;
  integers[3] = input.substeps;
  floats[4] = Math.fround(input.dtSeconds);
  floats[5] = Math.fround(input.complianceDistance);
  floats[6] = Math.fround(input.complianceVolume);
  floats[7] = Math.fround(input.damping);
  floats[8] = Math.fround(input.gravity[0]);
  floats[9] = Math.fround(input.gravity[1]);
  floats[10] = Math.fround(input.gravity[2]);
  return out;
}
function projectEdge(state, edge, alpha) {
  const a = edge.a * 12;
  const b = edge.b * 12;
  const wa = state[a + 3];
  const wb = state[b + 3];
  const denominator = wa + wb;
  if (denominator === 0) return;
  const dx = state[a] - state[b];
  const dy = state[a + 1] - state[b + 1];
  const dz = state[a + 2] - state[b + 2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length === 0) return;
  const correction = (edge.restLength - length) / (denominator + alpha);
  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;
  state[a] = state[a] + wa * correction * nx;
  state[a + 1] = state[a + 1] + wa * correction * ny;
  state[a + 2] = state[a + 2] + wa * correction * nz;
  state[b] = state[b] - wb * correction * nx;
  state[b + 1] = state[b + 1] - wb * correction * ny;
  state[b + 2] = state[b + 2] - wb * correction * nz;
}
function projectVolume(state, tet, alpha) {
  const ids = [tet.i0, tet.i1, tet.i2, tet.i3];
  const p = ids.map((index) => index * 12);
  const e1 = sub(state, p[1], p[3]);
  const e2 = sub(state, p[2], p[3]);
  const g0 = scale(cross(e1, e2), 1 / 6);
  const g1 = scale(cross(e2, sub(state, p[0], p[3])), 1 / 6);
  const g2 = scale(cross(sub(state, p[0], p[3]), e1), 1 / 6);
  const gradients = [g0, g1, g2, [-g0[0] - g1[0] - g2[0], -g0[1] - g1[1] - g2[1], -g0[2] - g1[2] - g2[2]]];
  let denominator = 0;
  for (let i = 0; i < 4; i += 1) {
    const w = state[p[i] + 3];
    const g = gradients[i];
    denominator += w * (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
  }
  if (denominator === 0) return;
  const volume = dot(sub(state, p[0], p[3]), cross(sub(state, p[1], p[3]), sub(state, p[2], p[3]))) / 6;
  const correction = (tet.restVolume - volume) / (denominator + alpha);
  for (let i = 0; i < 4; i += 1) {
    const base = p[i];
    const w = state[base + 3];
    const g = gradients[i];
    const scaleValue = w * correction;
    state[base] = state[base] + scaleValue * g[0];
    state[base + 1] = state[base + 1] + scaleValue * g[1];
    state[base + 2] = state[base + 2] + scaleValue * g[2];
  }
}
function sub(state, a, b) {
  return [state[a] - state[b], state[a + 1] - state[b + 1], state[a + 2] - state[b + 2]];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function scale(a, value) {
  return [a[0] * value, a[1] * value, a[2] * value];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function validateStepInput2(input) {
  if (!input || input.particles.length < 4) throw new Error("Soft-body GPU step needs at least four particles.");
  if (!Number.isSafeInteger(input.substeps) || input.substeps < 1) throw new Error("Soft-body GPU substeps must be an integer >= 1.");
  if (!(input.dtSeconds > 0) || !Number.isFinite(input.dtSeconds)) throw new Error("Soft-body GPU dtSeconds must be positive and finite.");
  if (!(input.complianceDistance >= 0) || !Number.isFinite(input.complianceDistance)) throw new Error("Soft-body GPU distance compliance must be finite and >= 0.");
  if (!(input.complianceVolume >= 0) || !Number.isFinite(input.complianceVolume)) throw new Error("Soft-body GPU volume compliance must be finite and >= 0.");
  if (!(input.damping >= 0) || input.damping >= 1 || !Number.isFinite(input.damping)) throw new Error("Soft-body GPU damping must be finite in [0,1).");
  if (input.gravity.length !== 3 || !input.gravity.every(Number.isFinite)) throw new Error("Soft-body GPU gravity must contain three finite values.");
  input.particles.forEach((particle, index) => validateParticle2(particle, index));
  input.edges.forEach((edge, index) => validateEdge(edge, index, input.particles.length));
  input.tets.forEach((tet, index) => validateTet(tet, index, input.particles.length));
}
function validateParticle2(particle, index) {
  if (!particle.position.every(Number.isFinite) || !particle.velocity.every(Number.isFinite) || !Number.isFinite(particle.inverseMass) || particle.inverseMass < 0) throw new Error(`Soft-body GPU particle ${index} is invalid.`);
}
function validateEdge(edge, index, count) {
  if (!Number.isSafeInteger(edge.a) || !Number.isSafeInteger(edge.b) || edge.a < 0 || edge.a >= count || edge.b < 0 || edge.b >= count) throw new Error(`Soft-body GPU edge ${index} references a particle outside [0,${count}).`);
  if (!(edge.restLength > 0) || !Number.isFinite(edge.restLength)) throw new Error(`Soft-body GPU edge ${index} restLength must be positive and finite.`);
}
function validateTet(tet, index, count) {
  for (const id of [tet.i0, tet.i1, tet.i2, tet.i3]) if (!Number.isSafeInteger(id) || id < 0 || id >= count) throw new Error(`Soft-body GPU tet ${index} references a particle outside [0,${count}).`);
  if (!(tet.restVolume > 0) || !Number.isFinite(tet.restVolume)) throw new Error(`Soft-body GPU tet ${index} restVolume must be positive and finite.`);
}
var SOFT_BODY_GPU_EDGE_STRIDE_BYTES, SOFT_BODY_GPU_TET_STRIDE_BYTES, SOFT_BODY_GPU_PARAMS_BYTES;
var init_softBodyGpuWgsl = __esm({
  "src/physics/softBodyGpuWgsl.ts"() {
    "use strict";
    SOFT_BODY_GPU_EDGE_STRIDE_BYTES = 16;
    SOFT_BODY_GPU_TET_STRIDE_BYTES = 32;
    SOFT_BODY_GPU_PARAMS_BYTES = 48;
  }
});

// src/physics/softBodyVolumeColoring.ts
var softBodyVolumeColoring_exports = {};
__export(softBodyVolumeColoring_exports, {
  colorSoftBodyVolumes: () => colorSoftBodyVolumes
});
function colorSoftBodyVolumes(tets, particleCount) {
  if (!Number.isSafeInteger(particleCount) || particleCount < 1) {
    throw new Error(`soft-body volume coloring: particleCount must be an integer >= 1, got ${particleCount}.`);
  }
  for (let t = 0; t < tets.length; t += 1) {
    for (const index of tets[t]) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= particleCount) {
        throw new Error(`soft-body volume coloring: tet ${t} references particle ${index} out of range [0,${particleCount}).`);
      }
    }
  }
  const particleTets = Array.from({ length: particleCount }, () => []);
  for (let t = 0; t < tets.length; t += 1) {
    for (const index of tets[t]) particleTets[index].push(t);
  }
  const adjacency = Array.from({ length: tets.length }, () => /* @__PURE__ */ new Set());
  let maxTetDegree = 0;
  for (let p = 0; p < particleCount; p += 1) {
    const bucket = particleTets[p];
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        adjacency[bucket[i]].add(bucket[j]);
        adjacency[bucket[j]].add(bucket[i]);
      }
    }
  }
  for (let t = 0; t < tets.length; t += 1) {
    if (adjacency[t].size > maxTetDegree) maxTetDegree = adjacency[t].size;
  }
  const colors = new Uint16Array(tets.length);
  for (let t = 0; t < tets.length; t += 1) {
    const used = /* @__PURE__ */ new Set();
    for (const neighbor of adjacency[t]) if (neighbor < t) used.add(colors[neighbor]);
    let color = 0;
    while (used.has(color)) color += 1;
    colors[t] = color;
  }
  let colorCount = 0;
  for (let t = 0; t < tets.length; t += 1) if (colors[t] + 1 > colorCount) colorCount = colors[t] + 1;
  const bucketStart = new Int32Array(colorCount + 1);
  for (let t = 0; t < tets.length; t += 1) bucketStart[colors[t]] += 1;
  let prefix = 0;
  for (let c = 0; c < colorCount; c += 1) {
    const size = bucketStart[c];
    bucketStart[c] = prefix;
    prefix += size;
  }
  bucketStart[colorCount] = prefix;
  const order = new Uint32Array(tets.length);
  for (let t = 0; t < tets.length; t += 1) {
    order[bucketStart[colors[t]]] = t;
    bucketStart[colors[t]] += 1;
  }
  const colorRanges = [];
  let previous = 0;
  for (let c = 0; c < colorCount; c += 1) {
    colorRanges.push([previous, bucketStart[c]]);
    previous = bucketStart[c];
  }
  return { colors, colorCount, order, colorRanges, maxTetDegree };
}
var init_softBodyVolumeColoring = __esm({
  "src/physics/softBodyVolumeColoring.ts"() {
    "use strict";
  }
});

// src/physics/softBodyParallelSolverWgsl.ts
var SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE, SOFT_BODY_PARALLEL_ENTRY_INTEGRATE, SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES, SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES, SOFT_BODY_PARALLEL_ENTRY_FINALIZE, SOFT_BODY_PARALLEL_SOLVER_WGSL;
var init_softBodyParallelSolverWgsl = __esm({
  "src/physics/softBodyParallelSolverWgsl.ts"() {
    "use strict";
    SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE = 64;
    SOFT_BODY_PARALLEL_ENTRY_INTEGRATE = "integrateParticles";
    SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES = "projectEdgesColor";
    SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES = "projectVolumesColor";
    SOFT_BODY_PARALLEL_ENTRY_FINALIZE = "finalizeParticles";
    SOFT_BODY_PARALLEL_SOLVER_WGSL = /* wgsl */
    `
struct SoftBodyParticle { position: vec4f, velocity: vec4f, previous: vec4f }
struct SoftBodyEdge { a: u32, b: u32, restLength: f32, _p0: u32 }
struct SoftBodyTet { i0: u32, i1: u32, i2: u32, i3: u32, restVolume: f32, _p0: u32, _p1: u32, _p2: u32 }
struct Params {
  substeps: u32, particleCount: u32, edgeCount: u32, tetCount: u32,
  dtSeconds: f32, complianceDistance: f32, complianceVolume: f32, damping: f32,
  gravity: vec4f,
}
@group(0) @binding(0) var<storage, read_write> particles: array<SoftBodyParticle>;
@group(0) @binding(1) var<storage, read> edges: array<SoftBodyEdge>;
@group(0) @binding(2) var<storage, read> tets: array<SoftBodyTet>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<uniform> colorRange: vec4u;
@group(0) @binding(5) var<storage, read_write> kineticPartials: array<f32>;

fn integrateOne(index: u32, h: f32, dampingScale: f32) {
  var particle = particles[index];
  particle.previous = particle.position;
  if (particle.position.w == 0.0) { particle.velocity = vec4f(0.0); }
  else {
    let velocity = (particle.velocity.xyz + params.gravity.xyz * h) * dampingScale;
    particle.velocity = vec4f(velocity, particle.velocity.w);
    particle.position = vec4f(particle.position.xyz + velocity * h, particle.position.w);
  }
  particles[index] = particle;
}

fn finalizeOne(index: u32, invH: f32) {
  var particle = particles[index];
  if (particle.position.w == 0.0) { particle.velocity = vec4f(0.0); }
  else { particle.velocity = vec4f((particle.position.xyz - particle.previous.xyz) * invH, particle.velocity.w); }
  particles[index] = particle;
}

@compute @workgroup_size(64)
fn integrateParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.particleCount) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  integrateOne(id.x, h, 1.0 - params.damping * h);
}

// \u8FB9\u8DDD\u79BB\u6295\u5F71(\u6BCF\u8FB9\u4E00 invocation;colorRange=[start,end) \u5708\u5B9A\u672C\u8272\u6279)\u3002
@compute @workgroup_size(64)
fn projectEdgesColor(@builtin(global_invocation_id) id: vec3u) {
  let edgeIndex = colorRange.x + id.x;
  if (id.x >= colorRange.y - colorRange.x) { return; }
  let edge = edges[edgeIndex];
  var a = particles[edge.a]; var b = particles[edge.b];
  let delta = a.position.xyz - b.position.xyz;
  let length = sqrt(dot(delta, delta));
  let denominator = a.position.w + b.position.w;
  if (length > 0.0 && denominator > 0.0) {
    let h = params.dtSeconds / max(f32(params.substeps), 1.0);
    let alphaEdge = params.complianceDistance / (h * h);
    let correction = (edge.restLength - length) / (denominator + alphaEdge);
    let direction = delta / length;
    a.position = vec4f(a.position.xyz + direction * correction * a.position.w, a.position.w);
    b.position = vec4f(b.position.xyz - direction * correction * b.position.w, b.position.w);
    particles[edge.a] = a; particles[edge.b] = b;
  }
}

// \u4F53\u79EF\u6295\u5F71(\u6BCF tet \u4E00 invocation;\u56DB\u89D2 XPBD \u68AF\u5EA6,\u516C\u5F0F\u4E0E\u4E32\u884C\u6838\u9010\u53E5\u540C\u6E90)\u3002
@compute @workgroup_size(64)
fn projectVolumesColor(@builtin(global_invocation_id) id: vec3u) {
  let tetIndex = colorRange.x + id.x;
  if (id.x >= colorRange.y - colorRange.x) { return; }
  let tet = tets[tetIndex];
  let ids = array<u32, 4>(tet.i0, tet.i1, tet.i2, tet.i3);
  var gradients: array<vec3f, 4>;
  let p0 = particles[tet.i0].position.xyz; let p1 = particles[tet.i1].position.xyz;
  let p2 = particles[tet.i2].position.xyz; let p3 = particles[tet.i3].position.xyz;
  gradients[0] = cross(p1 - p3, p2 - p3) / 6.0;
  gradients[1] = cross(p2 - p3, p0 - p3) / 6.0;
  gradients[2] = cross(p0 - p3, p1 - p3) / 6.0;
  gradients[3] = -(gradients[0] + gradients[1] + gradients[2]);
  var denominator = 0.0;
  for (var corner = 0u; corner < 4u; corner += 1u) {
    denominator += particles[ids[corner]].position.w * dot(gradients[corner], gradients[corner]);
  }
  if (denominator <= 0.0) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  let alphaVolume = params.complianceVolume / (h * h);
  let volume = dot(p0 - p3, cross(p1 - p3, p2 - p3)) / 6.0;
  let correction = (tet.restVolume - volume) / (denominator + alphaVolume);
  for (var corner = 0u; corner < 4u; corner += 1u) {
    var particle = particles[ids[corner]];
    particle.position = vec4f(particle.position.xyz + particle.position.w * correction * gradients[corner], particle.position.w);
    particles[ids[corner]] = particle;
  }
}

// \u901F\u5EA6\u56DE\u7B97 + \u52A8\u80FD\u90E8\u5206\u548C(\u6BCF invocation \u5199\u81EA\u8EAB\u7C92\u5B50\u7684 v\xB2/2 \u90E8\u5206\u548C\u69FD\u4F4D\u7531\u5BBF\u4E3B\u5F52\u7EA6;
// \u7B2C\u4E00\u5200\u53EA\u505A\u901F\u5EA6\u56DE\u7B97,kinetic \u69FD\u4FDD\u7559\u5E03\u5C40\u4F9B\u7B2C\u4E09\u5200\u955C\u50CF\u5BF9\u9F50)\u3002
@compute @workgroup_size(64)
fn finalizeParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.particleCount) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  finalizeOne(id.x, 1.0 / h);
}
`;
  }
});

// src/physics/softBodyGpuDispatch.softbodyParallel.ts
var softBodyGpuDispatch_softbodyParallel_exports = {};
__export(softBodyGpuDispatch_softbodyParallel_exports, {
  dispatchSoftBodyParallelGpuStep: () => dispatchSoftBodyParallelGpuStep,
  mirrorSoftBodyParallelStep: () => mirrorSoftBodyParallelStep,
  softBodyParallelDispatchCount: () => softBodyParallelDispatchCount
});
function softBodyParallelDispatchCount(substeps, edgeColors, volumeColors) {
  return substeps * (2 + edgeColors + volumeColors);
}
function softBodyParallelPipelines(device) {
  let cached = pipelineCache2.get(device);
  if (!cached) {
    cached = (async () => {
      const module = device.createShaderModule({ code: SOFT_BODY_PARALLEL_SOLVER_WGSL });
      const entry = async (entryPoint) => device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint }
      });
      return {
        integrate: await entry(SOFT_BODY_PARALLEL_ENTRY_INTEGRATE),
        projectEdges: await entry(SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES),
        projectVolumes: await entry(SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES),
        finalize: await entry(SOFT_BODY_PARALLEL_ENTRY_FINALIZE)
      };
    })();
    pipelineCache2.set(device, cached);
    cached.catch(() => pipelineCache2.delete(device));
  }
  return cached;
}
function createBuffer3(device, size, usage, source) {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source);
  return buffer;
}
async function dispatchSoftBodyParallelGpuStep(device, input) {
  const packedParticles = packSoftBodyGpuParticles(input.particles);
  const packedEdges = packSoftBodyGpuEdges(input.edges, input.particles.length);
  const packedTets = packSoftBodyGpuTets(input.tets, input.particles.length);
  const packedParams = packSoftBodyGpuParams(input);
  const edgeColoring = colorClothConstraints(
    input.edges.map((edge) => edge.a),
    input.edges.map((edge) => edge.b),
    input.particles.length
  );
  const volumeColoring = colorSoftBodyVolumes(
    input.tets.map((tet) => [tet.i0, tet.i1, tet.i2, tet.i3]),
    input.particles.length
  );
  const workgroups = Math.ceil(input.particles.length / SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const pipelines = await softBodyParallelPipelines(device);
  const usage = parallelUsages2();
  const stateBuffer = createBuffer3(device, packedParticles.byteLength, usage.state, packedParticles);
  const edgeBuffer = createBuffer3(device, packedEdges.byteLength, usage.state, packedEdges);
  const tetBuffer = createBuffer3(device, packedTets.byteLength, usage.state, packedTets);
  const paramsBuffer = createBuffer3(device, packedParams.byteLength, usage.uniform, packedParams);
  const edgeRangeBuffers = edgeColoring.colorRanges.map(([start, end]) => createBuffer3(device, 16, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const volumeRangeBuffers = volumeColoring.colorRanges.map(([start, end]) => createBuffer3(device, 16, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const readbackBuffer = createBuffer3(device, packedParticles.byteLength, usage.readback);
  const integrateBindGroup = device.createBindGroup({
    layout: pipelines.integrate.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } }
    ]
  });
  const edgeBindGroups = edgeRangeBuffers.map((buffer) => device.createBindGroup({
    layout: pipelines.projectEdges.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 1, resource: { buffer: edgeBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer } }
    ]
  }));
  const volumeBindGroups = volumeRangeBuffers.map((buffer) => device.createBindGroup({
    layout: pipelines.projectVolumes.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: tetBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer } }
    ]
  }));
  const finalizeBindGroup = device.createBindGroup({
    layout: pipelines.finalize.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } }
    ]
  });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    for (let substep = 0; substep < input.substeps; substep += 1) {
      pass.setPipeline(pipelines.integrate);
      pass.setBindGroup(0, integrateBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.setPipeline(pipelines.projectEdges);
      for (let color = 0; color < edgeColoring.colorCount; color += 1) {
        pass.setBindGroup(0, edgeBindGroups[color]);
        pass.dispatchWorkgroups(Math.ceil((edgeColoring.colorRanges[color][1] - edgeColoring.colorRanges[color][0]) / SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE));
      }
      pass.setPipeline(pipelines.projectVolumes);
      for (let color = 0; color < volumeColoring.colorCount; color += 1) {
        pass.setBindGroup(0, volumeBindGroups[color]);
        pass.dispatchWorkgroups(Math.ceil((volumeColoring.colorRanges[color][1] - volumeColoring.colorRanges[color][0]) / SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE));
      }
      pass.setPipeline(pipelines.finalize);
      pass.setBindGroup(0, finalizeBindGroup);
      pass.dispatchWorkgroups(workgroups);
    }
    pass.end();
    encoder.copyBufferToBuffer(stateBuffer, 0, readbackBuffer, 0, packedParticles.byteLength);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return {
      state: new Float32Array(readbackBuffer.getMappedRange().slice(0)),
      dispatchCount: softBodyParallelDispatchCount(input.substeps, edgeColoring.colorCount, volumeColoring.colorCount),
      edgeColors: edgeColoring.colorCount,
      volumeColors: volumeColoring.colorCount
    };
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [stateBuffer, edgeBuffer, tetBuffer, paramsBuffer, readbackBuffer, ...edgeRangeBuffers, ...volumeRangeBuffers]) buffer.destroy();
  }
}
function mirrorSoftBodyParallelStep(input, edgeColoring, volumeColoring) {
  const state = packSoftBodyGpuParticles(input.particles);
  const h = input.dtSeconds / input.substeps;
  const alphaEdge = input.complianceDistance / (h * h);
  const alphaVolume = input.complianceVolume / (h * h);
  const dampingScale = 1 - input.damping * h;
  const [gx, gy, gz] = input.gravity;
  for (let substep = 0; substep < input.substeps; substep += 1) {
    for (let i = 0; i < input.particles.length; i += 1) {
      const base = i * 12;
      state[base + 8] = state[base];
      state[base + 9] = state[base + 1];
      state[base + 10] = state[base + 2];
      const inverseMass = state[base + 3];
      if (inverseMass === 0) {
        state[base + 4] = 0;
        state[base + 5] = 0;
        state[base + 6] = 0;
        continue;
      }
      state[base + 4] = (state[base + 4] + gx * h) * dampingScale;
      state[base + 5] = (state[base + 5] + gy * h) * dampingScale;
      state[base + 6] = (state[base + 6] + gz * h) * dampingScale;
      state[base] = state[base] + state[base + 4] * h;
      state[base + 1] = state[base + 1] + state[base + 5] * h;
      state[base + 2] = state[base + 2] + state[base + 6] * h;
    }
    for (let bucket = 0; bucket < edgeColoring.colorRanges.length; bucket += 1) {
      const [start, end] = edgeColoring.colorRanges[bucket];
      for (let slot = start; slot < end; slot += 1) {
        const k = edgeColoring.order[slot];
        projectEdge(state, input.edges[k], alphaEdge);
      }
    }
    for (let bucket = 0; bucket < volumeColoring.colorRanges.length; bucket += 1) {
      const [start, end] = volumeColoring.colorRanges[bucket];
      for (let slot = start; slot < end; slot += 1) {
        const k = volumeColoring.order[slot];
        projectVolume(state, input.tets[k], alphaVolume);
      }
    }
    const inverseH = 1 / h;
    for (let i = 0; i < input.particles.length; i += 1) {
      const base = i * 12;
      if (state[base + 3] === 0) {
        state[base + 4] = 0;
        state[base + 5] = 0;
        state[base + 6] = 0;
        continue;
      }
      state[base + 4] = (state[base] - state[base + 8]) * inverseH;
      state[base + 5] = (state[base + 1] - state[base + 9]) * inverseH;
      state[base + 6] = (state[base + 2] - state[base + 10]) * inverseH;
    }
  }
  return state;
}
var parallelUsages2, pipelineCache2;
var init_softBodyGpuDispatch_softbodyParallel = __esm({
  "src/physics/softBodyGpuDispatch.softbodyParallel.ts"() {
    "use strict";
    init_clothConstraintColoring();
    init_softBodyVolumeColoring();
    init_softBodyParallelSolverWgsl();
    init_softBodyGpuWgsl();
    parallelUsages2 = () => ({
      uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    pipelineCache2 = /* @__PURE__ */ new WeakMap();
  }
});

// src/physics/clothParallelSolver.ts
init_clothConstraintColoring();
var f = Math.fround;
var CLOTH_PARALLEL_WORKGROUP_SIZE = 64;
function buildClothParallelState(config) {
  const c = config;
  if (!Number.isSafeInteger(c.columns) || c.columns < 2 || !Number.isSafeInteger(c.rows) || c.rows < 2) {
    throw new Error(`cloth parallel: columns/rows must be integers >= 2, got ${c.columns}x${c.rows}.`);
  }
  if (!(c.spacing > 0) || !(c.mass > 0) || !(c.dtSeconds > 0) || !Number.isFinite(c.dtSeconds)) {
    throw new Error("cloth parallel: spacing/mass/dtSeconds must be positive finite.");
  }
  if (!Number.isSafeInteger(c.substeps) || c.substeps < 1) throw new Error("cloth parallel: substeps must be integer >= 1.");
  const count = c.columns * c.rows;
  const state = new Float32Array(count * 12);
  let s = (c.seed | 0) + 2654435769 | 0;
  const nextUnit = () => {
    s = s + 1831565813 | 0;
    let t = s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const ox = c.origin?.[0] ?? 0;
  const oy = c.origin?.[1] ?? 0;
  const oz = c.origin?.[2] ?? 0;
  const invMass = f(1 / c.mass);
  for (let r = 0; r < c.rows; r += 1) {
    for (let col = 0; col < c.columns; col += 1) {
      const i = r * c.columns + col;
      const base = i * 12;
      state[base] = f(ox + col * c.spacing);
      state[base + 1] = f(oy + r * c.spacing);
      state[base + 2] = f(oz + (c.perturbation > 0 ? (nextUnit() - 0.5) * 2 * c.perturbation : 0));
      state[base + 3] = invMass;
      state[base + 8] = state[base];
      state[base + 9] = state[base + 1];
      state[base + 10] = state[base + 2];
    }
  }
  const ca = [];
  const cb = [];
  const rest = [];
  const diag = c.spacing * Math.SQRT2;
  for (let r = 0; r < c.rows; r += 1) {
    for (let col = 0; col < c.columns; col += 1) {
      const i = r * c.columns + col;
      if (col + 1 < c.columns) {
        ca.push(i);
        cb.push(i + 1);
        rest.push(c.spacing);
      }
      if (r + 1 < c.rows) {
        ca.push(i);
        cb.push(i + c.columns);
        rest.push(c.spacing);
      }
      if (col + 1 < c.columns && r + 1 < c.rows) {
        ca.push(i);
        cb.push(i + c.columns + 1);
        rest.push(diag);
        ca.push(i + 1);
        cb.push(i + c.columns);
        rest.push(diag);
      }
    }
  }
  const coloring = colorClothConstraints(ca, cb, count);
  const constraintBuffer = new ArrayBuffer(ca.length * 16);
  const ints = new Uint32Array(constraintBuffer);
  const floats = new Float32Array(constraintBuffer);
  for (let bucket = 0; bucket < coloring.order.length; bucket += 1) {
    const k = coloring.order[bucket];
    ints[bucket * 4] = ca[k];
    ints[bucket * 4 + 1] = cb[k];
    floats[bucket * 4 + 2] = f(rest[k]);
  }
  const pinnedSet = c.pinned ?? [];
  for (const [col, row] of pinnedSet) setPinned(state, c.columns, col, row, true);
  return {
    particleCount: count,
    constraintCount: ca.length,
    state,
    constraintBuffer,
    coloring,
    config: c
  };
}
function setPinned(state, columns, col, row, pinned) {
  const base = (row * columns + col) * 12;
  if (pinned) {
    state[base + 3] = 0;
    state[base + 4] = 0;
    state[base + 5] = 0;
    state[base + 6] = 0;
  }
}
function treeSum2(a, b) {
  return f(f(a) + f(b));
}
function treeSum4(a, b, c, d) {
  return f(treeSum2(a, b) + treeSum2(c, d));
}
function workgroupTreeSum(laneValues) {
  const width = CLOTH_PARALLEL_WORKGROUP_SIZE;
  const shared = new Float64Array(width);
  for (let i = 0; i < width; i += 1) shared[i] = i < laneValues.length ? f(laneValues[i]) : 0;
  let level = width;
  while (level > 1) {
    const half = level >> 1;
    for (let i = 0; i < half; i += 1) shared[i] = f(f(shared[i * 2]) + f(shared[i * 2 + 1]));
    level = half;
  }
  return shared[0];
}
function hostMergeTreeSum(partials) {
  let level = 1;
  while (level < partials.length) level *= 2;
  const shared = new Float64Array(level);
  for (let i = 0; i < level; i += 1) shared[i] = i < partials.length ? f(partials[i]) : 0;
  while (level > 1) {
    const half = level >> 1;
    for (let i = 0; i < half; i += 1) shared[i] = f(f(shared[i * 2]) + f(shared[i * 2 + 1]));
    level = half;
  }
  return shared[0];
}
function fingerprintFloat32(values) {
  const f32 = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) f32[i] = values[i];
  const bytes = new Uint8Array(f32.buffer);
  let forward = 2166136261;
  let backward = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    forward = Math.imul(forward ^ bytes[i], 16777619);
    backward = Math.imul(backward ^ bytes[bytes.length - 1 - i], 16777619);
  }
  const hex = (v) => (v >>> 0).toString(16).padStart(8, "0");
  return hex(forward) + hex(backward);
}
var ClothParallelMirror = class {
  #build;
  #state;
  #constraintInts;
  #constraintFloats;
  /** 每子步三级树归约后的动能 Σspeed²(最近一个 tick,子步序)。 */
  #kineticPerSubstep = [];
  #tick = 0;
  constructor(build) {
    this.#build = build;
    this.#state = build.state;
    this.#constraintInts = new Uint32Array(build.constraintBuffer);
    this.#constraintFloats = new Float32Array(build.constraintBuffer);
  }
  get build() {
    return this.#build;
  }
  get tick() {
    return this.#tick;
  }
  get kineticPerSubstep() {
    return this.#kineticPerSubstep;
  }
  /** 推进一个固定 tick(substeps 个色序子步)。 */
  step() {
    const build = this.#build;
    const cfg = build.config;
    const state = this.#state;
    const dt32 = f(cfg.dtSeconds);
    const h = f(dt32 / cfg.substeps);
    const hh = f(h * h);
    const alphaTilde = f(f(cfg.compliance) / hh);
    const dampingScale = f(1 - f(f(cfg.damping) * h));
    const invH = f(1 / h);
    const gx = f(cfg.gravity[0]);
    const gy = f(cfg.gravity[1]);
    const gz = f(cfg.gravity[2]);
    this.#kineticPerSubstep.length = 0;
    for (let sub2 = 0; sub2 < cfg.substeps; sub2 += 1) {
      for (let i = 0; i < build.particleCount; i += 1) {
        const base = i * 12;
        state[base + 8] = state[base];
        state[base + 9] = state[base + 1];
        state[base + 10] = state[base + 2];
        if (state[base + 3] === 0) {
          state[base + 4] = 0;
          state[base + 5] = 0;
          state[base + 6] = 0;
          continue;
        }
        state[base + 4] = f(f(state[base + 4] + f(gx * h)) * dampingScale);
        state[base + 5] = f(f(state[base + 5] + f(gy * h)) * dampingScale);
        state[base + 6] = f(f(state[base + 6] + f(gz * h)) * dampingScale);
        state[base] = f(state[base] + f(state[base + 4] * h));
        state[base + 1] = f(state[base + 1] + f(state[base + 5] * h));
        state[base + 2] = f(state[base + 2] + f(state[base + 6] * h));
      }
      for (let color = 0; color < build.coloring.colorCount; color += 1) {
        const [start, end] = build.coloring.colorRanges[color];
        for (let bucket = start; bucket < end; bucket += 1) {
          this.#projectBucket(bucket, alphaTilde);
        }
      }
      const workgroups = Math.ceil(build.particleCount / CLOTH_PARALLEL_WORKGROUP_SIZE);
      const partials = new Float64Array(workgroups);
      for (let w = 0; w < workgroups; w += 1) {
        const lanes = new Float64Array(CLOTH_PARALLEL_WORKGROUP_SIZE);
        for (let lane = 0; lane < CLOTH_PARALLEL_WORKGROUP_SIZE; lane += 1) {
          const i = w * CLOTH_PARALLEL_WORKGROUP_SIZE + lane;
          if (i >= build.particleCount) break;
          const base = i * 12;
          if (state[base + 3] === 0) {
            state[base + 4] = 0;
            state[base + 5] = 0;
            state[base + 6] = 0;
            lanes[lane] = 0;
            continue;
          }
          state[base + 4] = f(f(state[base] - state[base + 8]) * invH);
          state[base + 5] = f(f(state[base + 1] - state[base + 9]) * invH);
          state[base + 6] = f(f(state[base + 2] - state[base + 10]) * invH);
          lanes[lane] = treeSum4(
            f(state[base + 4] * state[base + 4]),
            f(state[base + 5] * state[base + 5]),
            f(state[base + 6] * state[base + 6]),
            0
          );
        }
        partials[w] = workgroupTreeSum(lanes);
      }
      this.#kineticPerSubstep.push(hostMergeTreeSum(partials));
    }
    this.#tick += 1;
    for (let i = 0; i < state.length; i += 1) {
      if (!Number.isFinite(state[i])) throw new Error(`cloth parallel mirror diverged at float ${i}.`);
    }
  }
  /** 单约束投影(bucket 序),f32 每步舍入;与 WGSL projectColor 逐运算同构。 */
  #projectBucket(bucket, alphaTilde) {
    const state = this.#state;
    const ints = this.#constraintInts;
    const floats = this.#constraintFloats;
    const a = ints[bucket * 4];
    const b = ints[bucket * 4 + 1];
    const restLength = floats[bucket * 4 + 2];
    const aBase = a * 12;
    const bBase = b * 12;
    const wa = state[aBase + 3];
    const wb = state[bBase + 3];
    const denom = f(wa + wb);
    if (denom === 0) return;
    const dx = f(state[aBase] - state[bBase]);
    const dy = f(state[aBase + 1] - state[bBase + 1]);
    const dz = f(state[aBase + 2] - state[bBase + 2]);
    const lenSq = f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
    const len = f(Math.sqrt(lenSq));
    if (len === 0) return;
    const numerator = f(restLength - len);
    const denominator = f(denom + alphaTilde);
    const correction = f(numerator / denominator);
    if (correction === 0) return;
    const invLen = f(1 / len);
    const nx = f(dx * invLen);
    const ny = f(dy * invLen);
    const nz = f(dz * invLen);
    const scaleA = f(correction * wa);
    const scaleB = f(correction * wb);
    state[aBase] = f(state[aBase] + f(nx * scaleA));
    state[aBase + 1] = f(state[aBase + 1] + f(ny * scaleA));
    state[aBase + 2] = f(state[aBase + 2] + f(nz * scaleA));
    state[bBase] = f(state[bBase] - f(nx * scaleB));
    state[bBase + 1] = f(state[bBase + 1] - f(ny * scaleB));
    state[bBase + 2] = f(state[bBase + 2] - f(nz * scaleB));
  }
  /** f32 状态指纹:拼接序与黄金 [px,py,pz,vx,vy,vz] 一致。 */
  stateFingerprint32() {
    const build = this.#build;
    const n = build.particleCount;
    const all = new Float32Array(n * 6);
    const state = this.#state;
    for (let i = 0; i < n; i += 1) {
      const base = i * 12;
      all[i] = state[base];
      all[n + i] = state[base + 1];
      all[2 * n + i] = state[base + 2];
      all[3 * n + i] = state[base + 4];
      all[4 * n + i] = state[base + 5];
      all[5 * n + i] = state[base + 6];
    }
    return fingerprintFloat32(all);
  }
  /** 拉伸误差统计(f32 口径;指标同黄金 measureStretch)。 */
  measureStretch() {
    const build = this.#build;
    const state = this.#state;
    const floats = this.#constraintFloats;
    const ints = this.#constraintInts;
    let max = 0;
    let sum = 0;
    for (let bucket = 0; bucket < build.constraintCount; bucket += 1) {
      const a = ints[bucket * 4];
      const b = ints[bucket * 4 + 1];
      const restLength = floats[bucket * 4 + 2];
      const dx = f(state[a * 12] - state[b * 12]);
      const dy = f(state[a * 12 + 1] - state[b * 12 + 1]);
      const dz = f(state[a * 12 + 2] - state[b * 12 + 2]);
      const len = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
      const ratio = f(Math.abs(f(len - restLength)) / restLength);
      if (ratio > max) max = ratio;
      sum = f(sum + ratio);
    }
    return { maxRatio: max, meanRatio: f(sum / build.constraintCount), constraintCount: build.constraintCount };
  }
  /** 深拷贝状态(重放对拍用)。 */
  captureState() {
    return new Float32Array(this.#state);
  }
  restoreState(snapshot) {
    this.#state.set(snapshot);
  }
};

// scripts/clothParallelGpuProbe.ts
init_clothSolver();

// src/physics/softBodyGpuDispatch.clothParallel.ts
init_clothConstraintColoring();

// src/physics/clothGpuWgsl.ts
var CLOTH_GPU_CONSTRAINT_STRIDE_BYTES = 16;
var CLOTH_GPU_PARAMS_BYTES = 48;
function packClothGpuParticles(particles) {
  const out = new Float32Array(particles.length * 12);
  particles.forEach((particle, index) => {
    validateParticle(particle, index);
    const base = index * 12;
    out.set([...particle.position, particle.inverseMass], base);
    out.set([...particle.velocity, 0], base + 4);
    out.set([...particle.position, 0], base + 8);
  });
  return out;
}
function packClothGpuConstraints(constraints, particleCount) {
  const out = new ArrayBuffer(constraints.length * CLOTH_GPU_CONSTRAINT_STRIDE_BYTES);
  const view = new DataView(out);
  constraints.forEach((constraint, index) => {
    validateConstraint(constraint, index, particleCount);
    const offset = index * CLOTH_GPU_CONSTRAINT_STRIDE_BYTES;
    view.setUint32(offset, constraint.a, true);
    view.setUint32(offset + 4, constraint.b, true);
    view.setFloat32(offset + 8, constraint.restLength, true);
  });
  return out;
}
function packClothGpuParams(input) {
  validateStepInput(input);
  const out = new ArrayBuffer(CLOTH_GPU_PARAMS_BYTES);
  const integers = new Uint32Array(out);
  const floats = new Float32Array(out);
  integers[0] = input.particles.length;
  integers[1] = input.constraints.length;
  integers[2] = input.substeps;
  floats[4] = Math.fround(input.dtSeconds);
  floats[5] = Math.fround(input.compliance);
  floats[6] = Math.fround(input.damping);
  floats[8] = Math.fround(input.gravity[0]);
  floats[9] = Math.fround(input.gravity[1]);
  floats[10] = Math.fround(input.gravity[2]);
  return out;
}
function validateStepInput(input) {
  if (!input || input.particles.length < 1) throw new Error("Cloth GPU step needs at least one particle.");
  if (!Number.isSafeInteger(input.substeps) || input.substeps < 1) throw new Error("Cloth GPU substeps must be an integer >= 1.");
  if (!(input.dtSeconds > 0) || !Number.isFinite(input.dtSeconds)) throw new Error("Cloth GPU dtSeconds must be positive and finite.");
  if (!(input.compliance >= 0) || !Number.isFinite(input.compliance)) throw new Error("Cloth GPU compliance must be finite and >= 0.");
  if (!(input.damping >= 0) || input.damping >= 1 || !Number.isFinite(input.damping)) throw new Error("Cloth GPU damping must be finite in [0,1).");
  if (input.gravity.length !== 3 || !input.gravity.every(Number.isFinite)) throw new Error("Cloth GPU gravity must contain three finite values.");
  input.particles.forEach((particle, index) => validateParticle(particle, index));
  input.constraints.forEach((constraint, index) => validateConstraint(constraint, index, input.particles.length));
}
function validateParticle(particle, index) {
  if (!particle.position.every(Number.isFinite) || !particle.velocity.every(Number.isFinite) || !Number.isFinite(particle.inverseMass) || particle.inverseMass < 0) {
    throw new Error(`Cloth GPU particle ${index} must contain finite position/velocity and non-negative inverse mass.`);
  }
}
function validateConstraint(constraint, index, particleCount) {
  if (!Number.isSafeInteger(constraint.a) || !Number.isSafeInteger(constraint.b) || constraint.a < 0 || constraint.a >= particleCount || constraint.b < 0 || constraint.b >= particleCount) {
    throw new Error(`Cloth GPU constraint ${index} references a particle outside [0,${particleCount}).`);
  }
  if (!(constraint.restLength > 0) || !Number.isFinite(constraint.restLength)) throw new Error(`Cloth GPU constraint ${index} restLength must be positive and finite.`);
}
var CLOTH_GPU_COMPUTE_WGSL = (
  /* wgsl */
  `
struct ClothParticle {
  position: vec4f,
  velocity: vec4f,
  previous: vec4f,
}
struct ClothConstraint {
  a: u32,
  b: u32,
  restLength: f32,
  _padding: u32,
}
struct ClothParams {
  particleCount: u32,
  constraintCount: u32,
  substeps: u32,
  _padding0: u32,
  dtSeconds: f32,
  compliance: f32,
  damping: f32,
  _padding1: f32,
  gravity: vec4f,
}
@group(0) @binding(0) var<storage, read_write> particles: array<ClothParticle>;
@group(0) @binding(1) var<storage, read> constraints: array<ClothConstraint>;
@group(0) @binding(2) var<uniform> params: ClothParams;

@compute @workgroup_size(1, 1, 1)
fn stepCloth(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  let alpha = params.compliance / (h * h);
  let dampingScale = 1.0 - params.damping * h;
  for (var substep = 0u; substep < params.substeps; substep += 1u) {
    for (var i = 0u; i < params.particleCount; i += 1u) {
      var particle = particles[i];
      particle.previous = particle.position;
      if (particle.position.w == 0.0) {
        particle.velocity = vec4f(0.0);
      } else {
        let velocity = (particle.velocity.xyz + params.gravity.xyz * h) * dampingScale;
        particle.velocity = vec4f(velocity, particle.velocity.w);
        let position = particle.position.xyz + velocity * h;
        particle.position = vec4f(position, particle.position.w);
      }
      particles[i] = particle;
    }
    for (var k = 0u; k < params.constraintCount; k += 1u) {
      let constraint = constraints[k];
      var a = particles[constraint.a];
      var b = particles[constraint.b];
      let delta = a.position.xyz - b.position.xyz;
      let length = sqrt(dot(delta, delta));
      let denominator = a.position.w + b.position.w;
      if (length > 0.0 && denominator > 0.0) {
        let correction = (constraint.restLength - length) / (denominator + alpha);
        let direction = delta / length;
        a.position = vec4f(a.position.xyz + direction * correction * a.position.w, a.position.w);
        b.position = vec4f(b.position.xyz - direction * correction * b.position.w, b.position.w);
        particles[constraint.a] = a;
        particles[constraint.b] = b;
      }
    }
    for (var i = 0u; i < params.particleCount; i += 1u) {
      var particle = particles[i];
      if (particle.position.w == 0.0) {
        particle.velocity = vec4f(0.0);
      } else {
        let velocity = (particle.position.xyz - particle.previous.xyz) / h;
        particle.velocity = vec4f(velocity, particle.velocity.w);
      }
      particles[i] = particle;
    }
  }
}
`
);

// src/physics/clothSolverWgsl.ts
var CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE = 64;
var CLOTH_PARALLEL_PARAMS_BYTES = 48;
var CLOTH_PARALLEL_STEP_RANGE_BYTES = 16;
var CLOTH_PARALLEL_ENTRY_INTEGRATE = "integrateParticles";
var CLOTH_PARALLEL_ENTRY_PROJECT = "projectConstraintsColor";
var CLOTH_PARALLEL_ENTRY_FINALIZE = "finalizeVelocityKinetics";
var DEEP_CLOTH_PARALLEL_SOLVER_WGSL = (
  /* wgsl */
  "// T18 A3 \u5E76\u884C\u5207\u7247:\u5E03\u6599 XPBD \u8DDD\u79BB\u7EA6\u675F GPU compute \u6838(WGSL \u5355\u6E90\u771F\u6E90)\u3002\n//\n// \u786E\u5B9A\u6027\u5408\u540C(\u4E0E CPU f32 \u6A21\u62DF\u955C\u50CF src/physics/clothParallelSolver.ts \u9010\u8FD0\u7B97\u540C\u6784):\n// - \u6295\u5F71\u8DEF\u5F84 = \u786E\u5B9A\u6027\u56FE\u7740\u8272\u8272\u5E8F Gauss-Seidel:\u7EA6\u675F\u6309\u8272\u6876\u8FDE\u7EED\u5B58\u653E(colorRanges),\n//   \u540C\u8272\u7EA6\u675F\u4E24\u4E24\u4E0D\u5171\u4EAB\u7AEF\u70B9 \u2192 \u8272\u5185\u5E76\u884C\u65E0\u5199\u51B2\u7A81,\u8272\u95F4\u6309 dispatch \u987A\u5E8F\u4E32\u884C;\n//   \u8272\u5E8F\u7531\u5BBF\u4E3B\u7AEF\u8D2A\u5FC3\u7740\u8272(clothConstraintColoring.ts,\u7EAF\u6574\u578B)\u552F\u4E00\u51B3\u5B9A\u3002\n// - \u7EDF\u8BA1\u8DEF\u5F84 = \u4E09\u7EA7\u56FA\u5B9A\u5F52\u7EA6\u6811:lane \u5185 pairwise \u2192 workgroup 64 lane \u5171\u4EAB\u5185\u5B58\n//   pairwise \u6811(\u96F6\u586B\u5145)\u2192 \u6BCF workgroup \u4E00\u4E2A\u72EC\u7ACB slot(\u5355\u5199\u8005,\u65E0\u539F\u5B50),\n//   \u5BBF\u4E3B\u6309\u56FA\u5B9A\u5408\u5E76\u6811\u6C47\u603B\u3002\u6240\u6709\u6C42\u548C\u7684\u52A0\u6CD5\u914D\u5BF9\u5728\u53CC\u7AEF\u9010\u4F4D\u4E00\u81F4\u3002\n// - \u5168\u90E8\u7B97\u672F\u663E\u5F0F\u6807\u91CF\u5316(\u7981\u5411\u91CF\u5316\u91CD\u6392\u7A7A\u95F4),f32 IEEE-754 \u6B63\u786E\u820D\u5165,\u65E0 FMA \u4F9D\u8D56;\n//   \u9664 sqrt(IEEE \u6B63\u786E\u820D\u5165)\u5916\u65E0\u8D85\u8D8A\u51FD\u6570,\u65E0\u968F\u673A\u6E90,\u65E0\u65F6\u949F\u3002\n//\n// ABI(\u5BBF\u4E3B\u5E38\u91CF\u4E0E clothParallelSolver.ts \u4E92\u9489):\n// - \u7C92\u5B50 48 B ClothParticle{position+invMass, velocity, previous}(vec4f \xD73);\n// - \u7EA6\u675F 16 B ClothConstraint{a, b, restLength, pad},\u6309\u8272\u6876\u6392\u5E8F;\n// - \u5168\u5C40\u53C2\u6570 48 B ClothParams;\u6BCF\u8272 stepRange 16 B(rangeStart/rangeEnd);\n// - kineticPartials:\u6BCF workgroup 1 \u4E2A f32 slot(\u5355\u5199\u8005)\u3002\n//\n// \u771F\u503C\u94FE:clothSolver.ts(f64 \u9EC4\u91D1,\u6784\u5EFA\u5E8F\u6295\u5F71)\u662F\u7269\u7406\u771F\u503C;\u672C\u6838\u662F f32 \u5E76\u884C\n// \u52A0\u901F/\u8BC1\u636E\u8DEF\u5F84,\u4E0E\u9EC4\u91D1\u7684\u53D7\u63A7\u504F\u5DEE = f32 \u91CF\u5316 + \u8272\u6876\u5E8F\u6295\u5F71,\u91CF\u5316\u5BF9\u7167\u89C1\n// clothParallelSolver.test.ts \u7684\u9010\u6B65\u6307\u7EB9\u8868(\u5BB9\u5DEE\u5185,\u4E0D\u9010\u4F4D)\u3002\n\nconst DEEP_CLOTH_PARALLEL_WORKGROUP_SIZE: u32 = 64u;\n\nstruct ClothParticle {\n  position: vec4f,\n  velocity: vec4f,\n  previous: vec4f,\n}\nstruct ClothConstraint {\n  a: u32,\n  b: u32,\n  restLength: f32,\n  _padding: u32,\n}\nstruct ClothParams {\n  particleCount: u32,\n  constraintCount: u32,\n  substeps: u32,\n  colorCount: u32,\n  dtSeconds: f32,\n  compliance: f32,\n  damping: f32,\n  _padding1: f32,\n  gravity: vec4f,\n}\nstruct ClothStepRange {\n  rangeStart: u32,\n  rangeEnd: u32,\n  _padding0: u32,\n  _padding1: u32,\n}\n\n@group(0) @binding(0) var<storage, read_write> particles: array<ClothParticle>;\n@group(0) @binding(1) var<storage, read> constraints: array<ClothConstraint>;\n@group(0) @binding(2) var<uniform> params: ClothParams;\n@group(0) @binding(3) var<uniform> stepRange: ClothStepRange;\n@group(0) @binding(4) var<storage, read_write> kineticPartials: array<f32>;\n\nvar<workgroup> laneKinetics: array<f32, 64>;\n\n// pass A:\u79EF\u5206(\u6BCF\u7C92\u5B50\u72EC\u7ACB\u7EAF\u51FD\u6570;\u951A\u70B9\u4FDD\u6301\u539F\u4F4D\u5E76\u6E05\u96F6\u901F\u5EA6)\u3002\n@compute @workgroup_size(64)\nfn integrateParticles(@builtin(global_invocation_id) id: vec3u) {\n  let index = id.x;\n  if (index >= params.particleCount) { return; }\n  let h = params.dtSeconds / f32(params.substeps);\n  let dampingScale = 1.0 - params.damping * h;\n  var particle = particles[index];\n  // previous \u53EA\u642C xyz(w \u69FD\u4E0E CPU \u955C\u50CF clothParallelSolver.ts \u540C\u7EA6\u5B9A:\u4E0D\u5199\u3001\u4FDD\u6301 0;\n  // \u6574 vec4 \u8D4B\u503C\u4F1A\u628A invMass \u5E26\u8FDB w,\u6C61\u67D3\u8BFB\u56DE\u6001\u6307\u7EB9)\u3002\n  particle.previous = vec4f(particle.position.xyz, particle.previous.w);\n  if (particle.position.w == 0.0) {\n    particle.velocity = vec4f(0.0);\n    particles[index] = particle;\n    return;\n  }\n  let vx = (particle.velocity.x + params.gravity.x * h) * dampingScale;\n  let vy = (particle.velocity.y + params.gravity.y * h) * dampingScale;\n  let vz = (particle.velocity.z + params.gravity.z * h) * dampingScale;\n  particle.velocity = vec4f(vx, vy, vz, particle.velocity.w);\n  let px = particle.position.x + vx * h;\n  let py = particle.position.y + vy * h;\n  let pz = particle.position.z + vz * h;\n  particle.position = vec4f(px, py, pz, particle.position.w);\n  particles[index] = particle;\n}\n\n// pass B:\u5355\u8272\u7EA6\u675F\u6295\u5F71(\u8272\u5185\u7AEF\u70B9\u4E0D\u76F8\u4EA4;\u8272\u95F4\u7531 dispatch \u5E8F\u5B9A\u5E8F)\u3002\n@compute @workgroup_size(64)\nfn projectConstraintsColor(@builtin(global_invocation_id) id: vec3u) {\n  let bucket = stepRange.rangeStart + id.x;\n  if (id.x >= (stepRange.rangeEnd - stepRange.rangeStart)) { return; }\n  let h = params.dtSeconds / f32(params.substeps);\n  let alphaTilde = params.compliance / (h * h);\n  let constraint = constraints[bucket];\n  let aIndex = constraint.a;\n  let bIndex = constraint.b;\n  let aParticle = particles[aIndex];\n  let bParticle = particles[bIndex];\n  let weightA = aParticle.position.w;\n  let weightB = bParticle.position.w;\n  let denom = weightA + weightB;\n  if (denom == 0.0) { return; }\n  let dx = aParticle.position.x - bParticle.position.x;\n  let dy = aParticle.position.y - bParticle.position.y;\n  let dz = aParticle.position.z - bParticle.position.z;\n  let lenSq = (dx * dx + dy * dy) + dz * dz;\n  let len = sqrt(lenSq);\n  if (len == 0.0) { return; }\n  let numerator = constraint.restLength - len;\n  let denominator = denom + alphaTilde;\n  let correction = numerator / denominator;\n  if (correction == 0.0) { return; }\n  let invLen = 1.0 / len;\n  let nx = dx * invLen;\n  let ny = dy * invLen;\n  let nz = dz * invLen;\n  let scaleA = correction * weightA;\n  let scaleB = correction * weightB;\n  var aOut = aParticle;\n  var bOut = bParticle;\n  aOut.position = vec4f(aParticle.position.x + nx * scaleA,\n    aParticle.position.y + ny * scaleA,\n    aParticle.position.z + nz * scaleA, weightA);\n  bOut.position = vec4f(bParticle.position.x - nx * scaleB,\n    bParticle.position.y - ny * scaleB,\n    bParticle.position.z - nz * scaleB, weightB);\n  particles[aIndex] = aOut;\n  particles[bIndex] = bOut;\n}\n\n// pass C:\u901F\u5EA6\u56DE\u7B97 + \u4E09\u7EA7\u56FA\u5B9A\u5F52\u7EA6\u6811\u52A8\u80FD\u7EDF\u8BA1(\u5B9A\u5E8F\u5F52\u7EA6\u7684\u5B9E\u73B0\u4E0E\u8BC1\u636E)\u3002\n@compute @workgroup_size(64)\nfn finalizeVelocityKinetics(@builtin(global_invocation_id) id: vec3u,\n  @builtin(local_invocation_id) localId: vec3u,\n  @builtin(workgroup_id) workgroupId: vec3u) {\n  let index = id.x;\n  var lane = 0.0;\n  if (index < params.particleCount) {\n    let h = params.dtSeconds / f32(params.substeps);\n    let invH = 1.0 / h;\n    var particle = particles[index];\n    if (particle.position.w == 0.0) {\n      particle.velocity = vec4f(0.0);\n    } else {\n      let vx = (particle.position.x - particle.previous.x) * invH;\n      let vy = (particle.position.y - particle.previous.y) * invH;\n      let vz = (particle.position.z - particle.previous.z) * invH;\n      particle.velocity = vec4f(vx, vy, vz, particle.velocity.w);\n      lane = (vx * vx + vy * vy) + (vz * vz + 0.0);\n    }\n    particles[index] = particle;\n  }\n  laneKinetics[localId.x] = lane;\n  workgroupBarrier();\n  var level = DEEP_CLOTH_PARALLEL_WORKGROUP_SIZE;\n  loop {\n    if (level <= 1u) { break; }\n    level = level >> 1u;\n    if (localId.x < level) {\n      laneKinetics[localId.x] = laneKinetics[localId.x * 2u] + laneKinetics[localId.x * 2u + 1u];\n    }\n    workgroupBarrier();\n  }\n  if (localId.x == 0u) {\n    kineticPartials[workgroupId.x] = laneKinetics[0u];\n  }\n}\n"
);

// src/physics/softBodyGpuDispatch.ts
init_softBodyGpuWgsl();
var makeBuffer = (device, size, usage, source) => {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source);
  return buffer;
};
var storageRead = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
var readback = () => GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;
async function dispatchClothGpuStep(device, input) {
  const particles = packClothGpuParticles(input.particles);
  const constraints = packClothGpuConstraints(input.constraints, input.particles.length);
  const params = packClothGpuParams(input);
  const stateBytes = particles.byteLength;
  const uniform = makeBuffer(device, CLOTH_GPU_PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, params);
  const particleBuffer = makeBuffer(device, stateBytes, storageRead() | GPUBufferUsage.COPY_SRC, particles);
  const constraintBuffer = makeBuffer(device, constraints.byteLength, storageRead(), constraints);
  const readbackBuffer = makeBuffer(device, stateBytes, readback());
  try {
    const module = device.createShaderModule({ code: CLOTH_GPU_COMPUTE_WGSL });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "stepCloth" }
    });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: constraintBuffer } },
      { binding: 2, resource: { buffer: uniform } }
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(particleBuffer, 0, readbackBuffer, 0, stateBytes);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return { state: new Float32Array(readbackBuffer.getMappedRange().slice(0)) };
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [uniform, particleBuffer, constraintBuffer, readbackBuffer]) buffer.destroy();
  }
}

// src/physics/softBodyGpuDispatch.clothParallel.ts
var ClothParallelDispatchError = class extends Error {
  reason;
  constructor(reason, message) {
    super(message);
    this.name = "ClothParallelDispatchError";
    this.reason = reason;
  }
};
var telemetry = {
  parallelSteps: 0,
  serialSteps: 0,
  fallbacks: { "coloring-unavailable": 0, "wgsl-compile-error": 0, "gpu-error": 0 },
  lastFallbackReason: null
};
function noteClothParallelSessionStep() {
  telemetry.parallelSteps += 1;
}
function clothParallelDispatchCount(substeps, colorCount) {
  return substeps * (2 + colorCount);
}
var parallelUsages = () => ({
  uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
});
function packClothParallelParams(input, colorCount) {
  if (!Number.isSafeInteger(input.substeps) || input.substeps < 1) throw new Error(`Cloth parallel GPU substeps must be an integer >= 1, got ${input.substeps}.`);
  if (!(input.dtSeconds > 0) || !Number.isFinite(input.dtSeconds)) throw new Error("Cloth parallel GPU dtSeconds must be positive and finite.");
  if (!(input.compliance >= 0) || !Number.isFinite(input.compliance)) throw new Error("Cloth parallel GPU compliance must be finite and >= 0.");
  if (!(input.damping >= 0) || input.damping >= 1 || !Number.isFinite(input.damping)) throw new Error("Cloth parallel GPU damping must be finite in [0,1).");
  if (input.gravity.length !== 3 || !input.gravity.every(Number.isFinite)) throw new Error("Cloth parallel GPU gravity must contain three finite values.");
  const out = new ArrayBuffer(CLOTH_PARALLEL_PARAMS_BYTES);
  const integers = new Uint32Array(out);
  const floats = new Float32Array(out);
  integers[0] = input.particles.length;
  integers[1] = input.constraints.length;
  integers[2] = input.substeps;
  integers[3] = colorCount;
  floats[4] = Math.fround(input.dtSeconds);
  floats[5] = Math.fround(input.compliance);
  floats[6] = Math.fround(input.damping);
  floats[8] = Math.fround(input.gravity[0]);
  floats[9] = Math.fround(input.gravity[1]);
  floats[10] = Math.fround(input.gravity[2]);
  return out;
}
var pipelineCache = /* @__PURE__ */ new WeakMap();
function clothParallelPipelines(device) {
  let cached = pipelineCache.get(device);
  if (!cached) {
    cached = (async () => {
      let module;
      try {
        module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
        const info = await module.getCompilationInfo?.();
        const fatal = info?.messages.filter((message) => message.type === "error") ?? [];
        if (fatal.length) throw new Error(fatal.map((message) => message.message).join("; "));
      } catch (error) {
        throw new ClothParallelDispatchError(
          "wgsl-compile-error",
          `cloth parallel kernel compile failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const entry = async (entryPoint) => device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint }
      });
      return {
        integrate: await entry(CLOTH_PARALLEL_ENTRY_INTEGRATE),
        project: await entry(CLOTH_PARALLEL_ENTRY_PROJECT),
        finalize: await entry(CLOTH_PARALLEL_ENTRY_FINALIZE)
      };
    })();
    pipelineCache.set(device, cached);
    cached.catch(() => pipelineCache.delete(device));
  }
  return cached;
}
function createBuffer(device, size, usage, source) {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source);
  return buffer;
}
async function dispatchClothParallelGpuStep(device, input) {
  packClothGpuConstraints(input.constraints, input.particles.length);
  const endpointsA = input.constraints.map((constraint) => constraint.a);
  const endpointsB = input.constraints.map((constraint) => constraint.b);
  let coloring;
  try {
    coloring = colorClothConstraints(endpointsA, endpointsB, input.particles.length);
  } catch (error) {
    throw new ClothParallelDispatchError(
      "coloring-unavailable",
      `cloth parallel kernel needs a deterministic coloring: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const particles = packClothGpuParticles(input.particles);
  const orderedConstraints = Array.from(coloring.order, (index) => input.constraints[index]);
  const constraints = packClothGpuConstraints(orderedConstraints, input.particles.length);
  const params = packClothParallelParams(input, coloring.colorCount);
  const workgroups = Math.ceil(input.particles.length / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const projectWorkgroups = coloring.colorRanges.map(([start, end]) => Math.ceil((end - start) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));
  const pipelines = await clothParallelPipelines(device).catch((error) => {
    if (error instanceof ClothParallelDispatchError) throw error;
    throw new ClothParallelDispatchError("gpu-error", `cloth parallel pipeline creation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const usage = parallelUsages();
  const stateBuffer = createBuffer(device, particles.byteLength, usage.state, particles);
  const constraintBuffer = createBuffer(device, constraints.byteLength, usage.state, constraints);
  const paramsBuffer = createBuffer(device, params.byteLength, usage.uniform, params);
  const kineticBuffer = createBuffer(device, workgroups * 4, usage.state, new Float32Array(workgroups));
  const rangeBuffers = coloring.colorRanges.map(([start, end]) => createBuffer(device, CLOTH_PARALLEL_STEP_RANGE_BYTES, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const readbackBuffer = createBuffer(device, particles.byteLength, usage.readback);
  const projectBindGroups = rangeBuffers.map((buffer, color) => device.createBindGroup({
    layout: pipelines.project.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 1, resource: { buffer: constraintBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 3, resource: { buffer } }
    ]
  }));
  const integrateBindGroup = device.createBindGroup({
    layout: pipelines.integrate.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } }
    ]
  });
  const finalizeBindGroup = device.createBindGroup({
    layout: pipelines.finalize.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer: kineticBuffer } }
    ]
  });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    for (let substep = 0; substep < input.substeps; substep += 1) {
      pass.setPipeline(pipelines.integrate);
      pass.setBindGroup(0, integrateBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.setPipeline(pipelines.project);
      for (let color = 0; color < coloring.colorCount; color += 1) {
        pass.setBindGroup(0, projectBindGroups[color]);
        pass.dispatchWorkgroups(projectWorkgroups[color]);
      }
      pass.setPipeline(pipelines.finalize);
      pass.setBindGroup(0, finalizeBindGroup);
      pass.dispatchWorkgroups(workgroups);
    }
    pass.end();
    encoder.copyBufferToBuffer(stateBuffer, 0, readbackBuffer, 0, particles.byteLength);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return {
      state: new Float32Array(readbackBuffer.getMappedRange().slice(0)),
      dispatchCount: clothParallelDispatchCount(input.substeps, coloring.colorCount),
      colorCount: coloring.colorCount
    };
  } catch (error) {
    if (error instanceof ClothParallelDispatchError) throw error;
    throw new ClothParallelDispatchError("gpu-error", `cloth parallel device step failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [stateBuffer, constraintBuffer, paramsBuffer, kineticBuffer, readbackBuffer, ...rangeBuffers]) buffer.destroy();
  }
}
async function dispatchClothStepAuto(device, input, options = {}) {
  if ((options.kernel ?? "parallel-first") === "serial") {
    telemetry.serialSteps += 1;
    const serial = await dispatchClothGpuStep(device, input);
    return { ...serial, kernel: "cloth-serial", dispatchCount: 1, colorCount: 0, fallbackReason: null };
  }
  try {
    const parallel = await dispatchClothParallelGpuStep(device, input);
    telemetry.parallelSteps += 1;
    return { ...parallel, kernel: "cloth-parallel", fallbackReason: null };
  } catch (error) {
    if (!(error instanceof ClothParallelDispatchError)) throw error;
    const reason = error.reason;
    telemetry.serialSteps += 1;
    telemetry.fallbacks[reason] += 1;
    telemetry.lastFallbackReason = reason;
    const serial = await dispatchClothGpuStep(device, input);
    return { ...serial, kernel: "cloth-serial", dispatchCount: 1, colorCount: 0, fallbackReason: reason };
  }
}

// src/physics/softBodyGpuDispatch.clothSession.ts
init_clothConstraintColoring();
var sessionUsages = () => ({
  uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
});
function createBuffer2(device, size, usage, source) {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source);
  return buffer;
}
async function sessionPipelines(device) {
  let module;
  try {
    module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
    const info = await module.getCompilationInfo?.();
    const fatal = info?.messages.filter((message) => message.type === "error") ?? [];
    if (fatal.length) throw new Error(fatal.map((message) => message.message).join("; "));
  } catch (error) {
    throw new ClothParallelDispatchError(
      "wgsl-compile-error",
      `cloth session kernel compile failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const entry = async (entryPoint) => device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint }
  });
  return {
    integrate: await entry(CLOTH_PARALLEL_ENTRY_INTEGRATE),
    project: await entry(CLOTH_PARALLEL_ENTRY_PROJECT),
    finalize: await entry(CLOTH_PARALLEL_ENTRY_FINALIZE)
  };
}
async function createClothGpuStepSession(device, input, options) {
  if (options.kernel !== "cloth-parallel" && options.kernel !== "cloth-serial") {
    throw new Error(`ClothGpuStepSession: kernel must be "cloth-parallel" or "cloth-serial", got ${String(options.kernel)}.`);
  }
  if (options.kernel === "cloth-serial") {
    return {
      kernel: "cloth-serial",
      colorCount: 0,
      buffersCreated: 0,
      async step(particles) {
        noteClothParallelSessionStep();
        const serial = await dispatchClothGpuStep(device, { ...input, particles });
        return { state: serial.state, dispatchCount: 1, colorCount: 0 };
      },
      dispose() {
      }
    };
  }
  packClothGpuConstraints(input.constraints, input.particles.length);
  let coloring;
  try {
    coloring = colorClothConstraints(
      input.constraints.map((constraint) => constraint.a),
      input.constraints.map((constraint) => constraint.b),
      input.particles.length
    );
  } catch (error) {
    throw new ClothParallelDispatchError(
      "coloring-unavailable",
      `cloth session needs a deterministic coloring: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const packedParticles = packClothGpuParticles(input.particles);
  const orderedConstraints = Array.from(coloring.order, (index) => input.constraints[index]);
  const packedConstraints = packClothGpuConstraints(orderedConstraints, input.particles.length);
  const paramsView = new DataView(new ArrayBuffer(CLOTH_PARALLEL_PARAMS_BYTES));
  {
    const integers = new Uint32Array(paramsView.buffer);
    const floats = new Float32Array(paramsView.buffer);
    integers[0] = input.particles.length;
    integers[1] = input.constraints.length;
    integers[2] = input.substeps;
    integers[3] = coloring.colorCount;
    floats[4] = Math.fround(input.dtSeconds);
    floats[5] = Math.fround(input.compliance);
    floats[6] = Math.fround(input.damping);
    floats[8] = Math.fround(input.gravity[0]);
    floats[9] = Math.fround(input.gravity[1]);
    floats[10] = Math.fround(input.gravity[2]);
  }
  const workgroups = Math.ceil(input.particles.length / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const projectWorkgroups = coloring.colorRanges.map(([start, end]) => Math.ceil((end - start) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));
  const usage = sessionUsages();
  const buffers = [];
  let pipelines;
  try {
    pipelines = await sessionPipelines(device).catch((error) => {
      if (error instanceof ClothParallelDispatchError) throw error;
      throw new ClothParallelDispatchError("gpu-error", `cloth session pipeline creation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const stateBuffer = createBuffer2(device, packedParticles.byteLength, usage.state, packedParticles);
    const constraintBuffer = createBuffer2(device, packedConstraints.byteLength, usage.state, packedConstraints);
    const paramsBuffer = createBuffer2(device, CLOTH_PARALLEL_PARAMS_BYTES, usage.uniform, paramsView.buffer);
    const kineticBuffer = createBuffer2(device, workgroups * 4, usage.state, new Float32Array(workgroups));
    const rangeBuffers = coloring.colorRanges.map(([start, end]) => createBuffer2(device, CLOTH_PARALLEL_STEP_RANGE_BYTES, usage.uniform, new Uint32Array([start, end, 0, 0])));
    const readbackBuffer = createBuffer2(device, packedParticles.byteLength, usage.readback);
    buffers.push(stateBuffer, constraintBuffer, paramsBuffer, kineticBuffer, readbackBuffer, ...rangeBuffers);
    const projectBindGroups = rangeBuffers.map((buffer) => device.createBindGroup({
      layout: pipelines.project.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: constraintBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: { buffer } }
      ]
    }));
    const integrateBindGroup = device.createBindGroup({
      layout: pipelines.integrate.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } }
      ]
    });
    const finalizeBindGroup = device.createBindGroup({
      layout: pipelines.finalize.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 4, resource: { buffer: kineticBuffer } }
      ]
    });
    let dead = false;
    const internals = {
      device,
      pipelines,
      stateBuffer,
      paramsBuffer,
      kineticBuffer,
      readbackBuffer,
      projectBindGroups,
      integrateBindGroup,
      finalizeBindGroup,
      workgroups,
      projectWorkgroups,
      colorCount: coloring.colorCount,
      substeps: input.substeps,
      particlesByteLength: packedParticles.byteLength,
      buffers
    };
    const session = {
      kernel: "cloth-parallel",
      colorCount: coloring.colorCount,
      buffersCreated: buffers.length,
      async step(particles) {
        if (dead) throw new ClothParallelDispatchError("gpu-error", "cloth session is dead after a device error; dispose and recreate.");
        noteClothParallelSessionStep();
        const packed = packClothGpuParticles(particles);
        try {
          internals.device.queue.writeBuffer(internals.stateBuffer, 0, packed);
          const encoder = internals.device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          for (let substep = 0; substep < internals.substeps; substep += 1) {
            pass.setPipeline(internals.pipelines.integrate);
            pass.setBindGroup(0, internals.integrateBindGroup);
            pass.dispatchWorkgroups(internals.workgroups);
            pass.setPipeline(internals.pipelines.project);
            for (let color = 0; color < internals.colorCount; color += 1) {
              pass.setBindGroup(0, internals.projectBindGroups[color]);
              pass.dispatchWorkgroups(internals.projectWorkgroups[color]);
            }
            pass.setPipeline(internals.pipelines.finalize);
            pass.setBindGroup(0, internals.finalizeBindGroup);
            pass.dispatchWorkgroups(internals.workgroups);
          }
          pass.end();
          encoder.copyBufferToBuffer(internals.stateBuffer, 0, internals.readbackBuffer, 0, internals.particlesByteLength);
          internals.device.queue.submit([encoder.finish()]);
          await internals.readbackBuffer.mapAsync(GPUMapMode.READ);
          return {
            state: new Float32Array(internals.readbackBuffer.getMappedRange().slice(0)),
            dispatchCount: clothParallelDispatchCount(internals.substeps, internals.colorCount),
            colorCount: internals.colorCount
          };
        } catch (error) {
          if (error instanceof ClothParallelDispatchError) {
            dead = true;
            throw error;
          }
          dead = true;
          throw new ClothParallelDispatchError("gpu-error", `cloth session step failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (internals.readbackBuffer.mapState === "mapped") internals.readbackBuffer.unmap();
        }
      },
      dispose() {
        dead = true;
        for (const buffer of buffers) buffer.destroy();
      }
    };
    return session;
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    void pipelines;
    throw error;
  }
}

// scripts/clothParallelGpuProbe.ts
var GRID = {
  columns: 12,
  rows: 12,
  spacing: 0.1,
  mass: 0.2,
  gravity: [0, -9.81, 0],
  dtSeconds: 1 / 60,
  substeps: 8,
  compliance: 0,
  damping: 0.01,
  perturbation: 5e-3,
  seed: 20260927,
  origin: [0, 0, 0]
};
var PINNED = [[0, 11], [11, 11]];
var TICKS = 240;
async function probeAdapterInfo() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return adapter.info ?? {};
}
function stateFingerprint(state, particleCount) {
  const all = new Float32Array(particleCount * 6);
  for (let i = 0; i < particleCount; i += 1) {
    all[i] = state[i * 12];
    all[particleCount + i] = state[i * 12 + 1];
    all[2 * particleCount + i] = state[i * 12 + 2];
    all[3 * particleCount + i] = state[i * 12 + 4];
    all[4 * particleCount + i] = state[i * 12 + 5];
    all[5 * particleCount + i] = state[i * 12 + 6];
  }
  return fingerprintFloat32(all);
}
function stretchMaxRatio(state, build) {
  const constraints = new Uint32Array(build.constraintBuffer);
  const rests = new Float32Array(build.constraintBuffer);
  let max = 0;
  for (let bucket = 0; bucket < build.constraintCount; bucket += 1) {
    const a = constraints[bucket * 4];
    const b = constraints[bucket * 4 + 1];
    const rest = rests[bucket * 4 + 2];
    const dx = state[a * 12] - state[b * 12];
    const dy = state[a * 12 + 1] - state[b * 12 + 1];
    const dz = state[a * 12 + 2] - state[b * 12 + 2];
    const ratio = Math.abs(Math.hypot(dx, dy, dz) - rest) / rest;
    if (ratio > max) max = ratio;
  }
  return max;
}
async function runReplay(device, module) {
  const build = buildClothParallelState({ ...GRID, pinned: PINNED });
  const mirror = new ClothParallelMirror(buildClothParallelState({ ...GRID, pinned: PINNED }));
  const particleCount = build.particleCount;
  const workgroups = Math.ceil(particleCount / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const stateBuffer = device.createBuffer({ size: build.state.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const constraintBuffer = device.createBuffer({ size: build.constraintBuffer.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const paramBytes = new ArrayBuffer(48);
  {
    const ints = new Uint32Array(paramBytes);
    const floats = new Float32Array(paramBytes);
    ints[0] = particleCount;
    ints[1] = build.constraintCount;
    ints[2] = GRID.substeps;
    ints[3] = build.coloring.colorCount;
    floats[4] = Math.fround(GRID.dtSeconds);
    floats[5] = Math.fround(GRID.compliance);
    floats[6] = Math.fround(GRID.damping);
    floats[8] = Math.fround(GRID.gravity[0]);
    floats[9] = Math.fround(GRID.gravity[1]);
    floats[10] = Math.fround(GRID.gravity[2]);
  }
  const paramsBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramsBuffer, 0, paramBytes);
  device.queue.writeBuffer(constraintBuffer, 0, build.constraintBuffer);
  device.queue.writeBuffer(stateBuffer, 0, build.state);
  const rangeBuffers = [];
  const projectBindGroups = [];
  const integratePipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: CLOTH_PARALLEL_ENTRY_INTEGRATE } });
  const projectPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: CLOTH_PARALLEL_ENTRY_PROJECT } });
  const finalizePipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: CLOTH_PARALLEL_ENTRY_FINALIZE } });
  for (const [start, end] of build.coloring.colorRanges) {
    const rangeBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(rangeBuffer, 0, new Uint32Array([start, end, 0, 0]));
    rangeBuffers.push(rangeBuffer);
  }
  const baseBindGroup = device.createBindGroup({
    layout: integratePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } }
    ]
  });
  const kineticBuffer = device.createBuffer({
    size: Math.max(4, workgroups * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  });
  device.queue.writeBuffer(kineticBuffer, 0, new Float32Array(workgroups));
  const finalizeBindGroup = device.createBindGroup({
    layout: finalizePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer: kineticBuffer } }
    ]
  });
  for (let color = 0; color < build.coloring.colorCount; color += 1) {
    projectBindGroups.push(device.createBindGroup({
      layout: projectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: constraintBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: { buffer: rangeBuffers[color] } }
      ]
    }));
  }
  const readback2 = device.createBuffer({ size: build.state.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const kineticReadback = device.createBuffer({
    size: Math.max(4, workgroups * 4),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const readState = async () => {
    device.queue.submit([]);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(stateBuffer, 0, readback2, 0, build.state.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback2.mapAsync(GPUMapMode.READ);
    const state = new Float32Array(readback2.getMappedRange().slice(0));
    readback2.unmap();
    return state;
  };
  const per24 = [];
  for (let tick = 1; tick <= TICKS; tick += 1) {
    mirror.step();
    for (let sub2 = 0; sub2 < GRID.substeps; sub2 += 1) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(integratePipeline);
      pass.setBindGroup(0, baseBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.setPipeline(projectPipeline);
      for (let color = 0; color < build.coloring.colorCount; color += 1) {
        pass.setBindGroup(0, projectBindGroups[color]);
        const [start, end] = build.coloring.colorRanges[color];
        pass.dispatchWorkgroups(Math.ceil((end - start) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));
      }
      pass.setPipeline(finalizePipeline);
      pass.setBindGroup(0, finalizeBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    if (tick % 24 === 0 || tick === TICKS) {
      const gpuState = await readState();
      const cpuState = mirror.captureState();
      let maxErr = 0;
      const diffIndexes = [];
      for (let i = 0; i < gpuState.length; i += 1) {
        const diff = Math.abs(gpuState[i] - cpuState[i]);
        if (diff > maxErr) {
          maxErr = diff;
          diffIndexes.length = 0;
          diffIndexes.push(i);
        } else if (diff === maxErr && diff > 0 && diffIndexes.length < 8) diffIndexes.push(i);
      }
      const gpuFingerprint = stateFingerprint(gpuState, particleCount);
      const cpuFingerprint = mirror.stateFingerprint32();
      per24.push({
        tick,
        cpuFingerprint,
        gpuFingerprint,
        bitwiseMatch: gpuFingerprint === cpuFingerprint,
        gpuMaxPosErrVsCpu: maxErr,
        diffIndexes
      });
    }
  }
  const finalState = await readState();
  device.queue.submit([]);
  const kEncoder = device.createCommandEncoder();
  kEncoder.copyBufferToBuffer(kineticBuffer, 0, kineticReadback, 0, workgroups * 4);
  device.queue.submit([kEncoder.finish()]);
  await kineticReadback.mapAsync(GPUMapMode.READ);
  const partials = new Float32Array(kineticReadback.getMappedRange().slice(0));
  kineticReadback.unmap();
  const gpuKinetic = hostMergeTreeSum(Array.from(partials));
  const cpuKinetic = mirror.kineticPerSubstep[mirror.kineticPerSubstep.length - 1];
  for (const buffer of [stateBuffer, constraintBuffer, paramsBuffer, readback2, kineticReadback, kineticBuffer, ...rangeBuffers]) buffer.destroy();
  return {
    per24,
    finalState,
    kinetic: { cpu: cpuKinetic, gpu: gpuKinetic, bitwiseMatch: gpuKinetic === cpuKinetic },
    replayDigest: stateFingerprint(finalState, particleCount)
  };
}
var cachedModule = null;
async function gpuContext() {
  if (cachedModule) return cachedModule;
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
  const info = await module.getCompilationInfo();
  const fatal = info.messages.filter((message) => message.type === "error");
  if (fatal.length) throw new Error(`WGSL compile failed: ${fatal.map((m) => m.message).join("; ")}`);
  cachedModule = { device, module };
  return cachedModule;
}
async function runClothParallelGpuReplay() {
  const { device, module } = await gpuContext();
  const first = await runReplay(device, module);
  const second = await runReplay(device, module);
  const golden = new ClothSolver({ ...GRID });
  for (const [col, row] of PINNED) golden.setPinned(col, row, true);
  for (let t = 0; t < TICKS; t += 1) golden.step();
  const snap = golden.capture();
  let goldenMaxErr = 0;
  for (let i = 0; i < first.finalState.length / 12; i += 1) {
    const dx = first.finalState[i * 12] - snap.px[i];
    const dy = first.finalState[i * 12 + 1] - snap.py[i];
    const dz = first.finalState[i * 12 + 2] - snap.pz[i];
    goldenMaxErr = Math.max(goldenMaxErr, Math.hypot(dx, dy, dz));
  }
  const bitwiseAll = first.per24.every((row) => row.bitwiseMatch);
  return {
    ticks: TICKS,
    per24: first.per24,
    simulationParityBitwise: bitwiseAll,
    maxStateFloatDriftVsCpu: Math.max(...first.per24.map((row) => row.gpuMaxPosErrVsCpu)),
    replayBitwise: first.replayDigest === second.replayDigest,
    kinetic: first.kinetic,
    golden: {
      maxPositionError: goldenMaxErr,
      tolerance: 0.05,
      withinTolerance: goldenMaxErr <= 0.05
    },
    stretch: {
      gpuMaxRatio: stretchMaxRatio(first.finalState, buildClothParallelState({ ...GRID, pinned: PINNED })),
      band: 0.05
    },
    deviceLost: device.lost ? "tracked" : "unknown"
  };
}
async function runClothParallelGpuProductionReplay() {
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
  const particlesFromState = (state2) => {
    const out = [];
    for (let i = 0; i < build.particleCount; i += 1) {
      const base = i * 12;
      out.push({
        position: [state2[base], state2[base + 1], state2[base + 2]],
        inverseMass: state2[base + 3],
        velocity: [state2[base + 4], state2[base + 5], state2[base + 6]]
      });
    }
    return out;
  };
  const physics = {
    constraints,
    particles: particlesFromState(build.state),
    dtSeconds: GRID.dtSeconds,
    substeps: GRID.substeps,
    compliance: GRID.compliance,
    damping: GRID.damping,
    gravity: [...GRID.gravity]
  };
  const maxPosErr = (a, b) => {
    let max = 0;
    for (let i = 0; i < build.particleCount; i += 1) {
      max = Math.max(max, Math.hypot(a[i * 12] - b[i * 12], a[i * 12 + 1] - b[i * 12 + 1], a[i * 12 + 2] - b[i * 12 + 2]));
    }
    return max;
  };
  const AUTO_TICKS = 64;
  const autoMirror = new ClothParallelMirror(buildClothParallelState({ ...GRID, pinned: PINNED }));
  let state = build.state;
  let kernel = null;
  let fallbackSeen = null;
  const autoPer24 = [];
  for (let tick = 1; tick <= AUTO_TICKS; tick += 1) {
    autoMirror.step();
    const result = await dispatchClothStepAuto(device, { ...physics, particles: particlesFromState(state) });
    kernel = result.kernel;
    if (result.fallbackReason) fallbackSeen = result.fallbackReason;
    state = result.state;
    if (tick % 24 === 0) autoPer24.push({ tick, maxPosErrVsMirror: maxPosErr(state, autoMirror.captureState()) });
  }
  const autoGolden = new ClothSolver({ ...GRID });
  for (const [col, row] of PINNED) autoGolden.setPinned(col, row, true);
  for (let t = 0; t < AUTO_TICKS; t += 1) autoGolden.step();
  const autoGoldenSnap = autoGolden.capture();
  let autoGoldenErr = 0;
  for (let i = 0; i < build.particleCount; i += 1) {
    autoGoldenErr = Math.max(autoGoldenErr, Math.hypot(
      state[i * 12] - autoGoldenSnap.px[i],
      state[i * 12 + 1] - autoGoldenSnap.py[i],
      state[i * 12 + 2] - autoGoldenSnap.pz[i]
    ));
  }
  const freshBuild = buildClothParallelState({ ...GRID, pinned: PINNED });
  const single = await dispatchClothStepAuto(device, { ...physics, particles: particlesFromState(freshBuild.state) });
  const session = await createClothGpuStepSession(device, physics, { kernel: "cloth-parallel" });
  const viaSession = await session.step(particlesFromState(freshBuild.state));
  let sessionBitwiseEqualsPerCall = single.state.length === viaSession.state.length;
  if (sessionBitwiseEqualsPerCall) {
    for (let i = 0; i < single.state.length; i += 1) {
      if (single.state[i] !== viaSession.state[i]) {
        sessionBitwiseEqualsPerCall = false;
        break;
      }
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
      sessionState[i * 12] - sessionGoldenSnap.px[i],
      sessionState[i * 12 + 1] - sessionGoldenSnap.py[i],
      sessionState[i * 12 + 2] - sessionGoldenSnap.pz[i]
    ));
  }
  const sessionMirrorErr = maxPosErr(sessionState, sessionMirror.captureState());
  const stretch = stretchMaxRatio(sessionState, buildClothParallelState({ ...GRID, pinned: PINNED }));
  session.dispose();
  return {
    production: {
      ticks: AUTO_TICKS,
      kernel,
      fallbackSeen,
      per24: autoPer24,
      goldenMaxPosErr: autoGoldenErr,
      goldenTolerance: 0.05,
      goldenWithinTolerance: autoGoldenErr <= 0.05
    },
    sessionProfile: {
      buffersCreated: session.buffersCreated,
      bitwiseEqualsPerCall: sessionBitwiseEqualsPerCall,
      ticks: SESSION_TICKS,
      goldenMaxPosErr: sessionGoldenErr,
      goldenWithinTolerance: sessionGoldenErr <= 0.05,
      mirrorMaxPosErr: sessionMirrorErr,
      stretchMaxRatio: stretch,
      stretchBand: 0.05,
      stretchWithinBand: stretch <= 0.05,
      disposed: true
    },
    gpuExecuted: true
  };
}
async function runSoftBodyParallelGpuCheck() {
  const { device } = await gpuContext();
  const { dispatchSoftBodyParallelGpuStep: dispatchSoftBodyParallelGpuStep2, mirrorSoftBodyParallelStep: mirrorSoftBodyParallelStep2 } = await Promise.resolve().then(() => (init_softBodyGpuDispatch_softbodyParallel(), softBodyGpuDispatch_softbodyParallel_exports));
  const { colorClothConstraints: colorClothConstraints2 } = await Promise.resolve().then(() => (init_clothConstraintColoring(), clothConstraintColoring_exports));
  const { colorSoftBodyVolumes: colorSoftBodyVolumes2 } = await Promise.resolve().then(() => (init_softBodyVolumeColoring(), softBodyVolumeColoring_exports));
  const { ClothSolver: ClothSolver2 } = await Promise.resolve().then(() => (init_clothSolver(), clothSolver_exports));
  const physics = {
    particles: [
      { position: [0, 0, 0], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [1, 0, 0], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [0, 1, 0], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [0, 0, 1], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [1, 1, 0], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [1, 0, 1], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [0, 1, 1], velocity: [0, 0, 0], inverseMass: 1 },
      { position: [1, 1, 1], velocity: [0, 0, 0], inverseMass: 1 }
    ],
    edges: [
      { a: 0, b: 1, restLength: 1 },
      { a: 0, b: 2, restLength: 1 },
      { a: 0, b: 3, restLength: 1 },
      { a: 1, b: 4, restLength: 1 },
      { a: 2, b: 4, restLength: 1 },
      { a: 3, b: 6, restLength: 1 }
    ],
    tets: [
      { i0: 0, i1: 1, i2: 2, i3: 3, restVolume: 0.5 },
      { i0: 1, i1: 4, i2: 2, i3: 3, restVolume: 0.5 },
      { i0: 1, i1: 5, i2: 3, i3: 4, restVolume: 0.5 },
      { i0: 2, i1: 3, i2: 6, i3: 4, restVolume: 0.5 },
      { i0: 1, i1: 2, i2: 4, i3: 6, restVolume: 0.5 },
      { i0: 1, i1: 3, i2: 5, i3: 6, restVolume: 0.5 }
    ],
    dtSeconds: 1 / 60,
    substeps: 8,
    complianceDistance: 1e-3,
    complianceVolume: 1e-3,
    damping: 0.01,
    gravity: [0, -9.81, 0]
  };
  const particlesFromState = (state) => physics.particles.map((_, i) => ({
    position: [state[i * 12], state[i * 12 + 1], state[i * 12 + 2]],
    velocity: [state[i * 12 + 4], state[i * 12 + 5], state[i * 12 + 6]],
    inverseMass: state[i * 12 + 3]
  }));
  const edgeColoring = colorClothConstraints2(physics.edges.map((e) => e.a), physics.edges.map((e) => e.b), physics.particles.length);
  const volumeColoring = colorSoftBodyVolumes2(physics.tets, physics.particles.length);
  const TICKS2 = 120;
  const maxPosErr = (gpu, mirror) => {
    let max = 0;
    for (let i = 0; i < physics.particles.length; i += 1) {
      max = Math.max(max, Math.hypot(gpu[i * 12] - mirror[i * 12], gpu[i * 12 + 1] - mirror[i * 12 + 1], gpu[i * 12 + 2] - mirror[i * 12 + 2]));
    }
    return max;
  };
  const digestOf = (state) => {
    let h = 2166136257;
    for (const byte of new Uint8Array(state.buffer, state.byteOffset, state.byteLength)) h = Math.imul(h ^ byte, 16777619) >>> 0;
    return h.toString(16);
  };
  const runOnce = async () => {
    let gpuState = packOf(physics.particles);
    let mirrorParticles = physics.particles.map((p) => ({ ...p }));
    const per24 = [];
    let finalState = gpuState;
    for (let tick = 1; tick <= TICKS2; tick += 1) {
      finalState = (await dispatchSoftBodyParallelGpuStep2(device, { ...physics, particles: particlesFromState(gpuState) })).state;
      mirrorParticles = particlesFromState(mirrorSoftBodyParallelStep2({ ...physics, particles: mirrorParticles }, edgeColoring, volumeColoring));
      gpuState = finalState;
      if (tick % 24 === 0) {
        const mirrorState = packOf(mirrorParticles);
        per24.push({ tick, maxErrVsMirror: maxPosErr(finalState, mirrorState) });
      }
    }
    return { finalState, per24, replayDigest: digestOf(finalState), goldenMaxErr: 0 };
  };
  function packOf(particles) {
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
    ticks: TICKS2,
    edgeColors: edgeColoring.colorCount,
    volumeColors: volumeColoring.colorCount,
    per24: first.per24,
    replayBitwise: first.replayDigest === second.replayDigest,
    dispatchPerTick: (2 + edgeColoring.colorCount + volumeColoring.colorCount) * physics.substeps,
    gpuExecuted: true
  };
}
export {
  probeAdapterInfo,
  runClothParallelGpuProductionReplay,
  runClothParallelGpuReplay,
  runSoftBodyParallelGpuCheck
};
