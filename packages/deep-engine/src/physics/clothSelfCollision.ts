/**
 * F6 切片:布料自碰撞 CPU 参考(粒子对最小距离,空间哈希)。
 *
 * 范围与如实声明:粒子-粒子投影式分离,单遍近似——不承诺完全无穿透,
 * 与障碍投影(contacts)的顺序固定为 contacts→self,两者同时满足不作合同。
 * 拓扑相邻粒子(结构/剪切约束端点,距离 ≥ spacing)由参数合同
 * 2r ≤ spacing 保证永不触发,无需排除集。全部 f64、固定遍历序
 * (集合序→粒子 index 升序、桶内 scatter 稳定),无随机源、无每帧分配。
 *
 * 同一分离核同时服务跨软体互碰(softBodyMutualCollision,crossOnly);
 * 单集合路径与首版实现等价(场景门+确定性测试守护;重合分支以预计算
 * diameter 除法与首版 1-ULP 内等价,无旧指纹合同)。
 */
export interface ClothSelfCollisionResolver {
  resolve(px: Float64Array, py: Float64Array, pz: Float64Array, inverseMass: Float64Array): void;
}

export interface ClothSelfCollisionConfig {
  readonly count: number;
  /** 粒子碰撞半径(米);接触距离 = 2r。 */
  readonly radius: number;
}

/** 分离核的粒子集合视图(单集合=自碰撞;多集合=跨软体互碰)。 */
export interface ParticleSeparationSet {
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly inverseMass: Float64Array;
  readonly count: number;
  /** 同集合粒子对排除谓词(软体自碰撞的 1 跳拓扑邻接);跨集合对不调用。 */
  readonly skipPair?: (i: number, j: number) => boolean;
}

export interface ParticleSeparationConfig {
  readonly sets: readonly ParticleSeparationSet[];
  /** 接触直径(米);接触距离 = diameter。 */
  readonly diameter: number;
  /** true 时只处理跨集合粒子对(互碰);false 含同集合对(自碰撞)。 */
  readonly crossOnly: boolean;
}

const BUCKET_BITS = 12;
const BUCKET_COUNT = 1 << BUCKET_BITS;

/** 确定性空间哈希:整数 cell 坐标混洗;冲突只造成多余候选,由 cell 复核过滤。 */
function bucketOf(cx: number, cy: number, cz: number): number {
  let h = Math.imul(cx, 0x8da6b343) ^ Math.imul(cy, 0xd8163841) ^ Math.imul(cz, 0xcb1ab31f);
  h ^= h >>> 15;
  return h & (BUCKET_COUNT - 1);
}

export function createParticleSeparation(config: ParticleSeparationConfig): { resolve(): void } {
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
  // 预分配:每子步两次 resolve 全程复用;计数排序无动态数组。
  const bucketStart = new Int32Array(BUCKET_COUNT + 1);
  const order = new Int32Array(total);
  const bucketOfParticle = new Int32Array(total);
  const cellX = new Int32Array(total);
  const cellY = new Int32Array(total);
  const cellZ = new Int32Array(total);
  // 扁平索引 → 集合与集合内 index;固定集合序保证确定性。
  const setIndex = new Int32Array(total);
  const particleIndex = new Int32Array(total);
  return { resolve(): void {
    // 缓冲覆盖校验在每次 resolve 开头:自碰撞包装的引用逐次换入,构造期无法校验。
    for (const set of sets) {
      if (set.px.length < set.count || set.py.length < set.count || set.pz.length < set.count || set.inverseMass.length < set.count) {
        throw new Error("ParticleSeparation: set buffers must cover count particles.");
      }
    }
    let flat = 0;
    bucketStart.fill(0);
    for (let s = 0; s < sets.length; s += 1) {
      const set = sets[s]!;
      for (let i = 0; i < set.count; i += 1) {
        const cx = Math.floor(set.px[i]! * invCell);
        const cy = Math.floor(set.py[i]! * invCell);
        const cz = Math.floor(set.pz[i]! * invCell);
        cellX[flat] = cx; cellY[flat] = cy; cellZ[flat] = cz;
        setIndex[flat] = s; particleIndex[flat] = i;
        const b = bucketOf(cx, cy, cz);
        bucketOfParticle[flat] = b;
        bucketStart[b] = bucketStart[b]! + 1;
        flat += 1;
      }
    }
    let prefix = 0;
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      const c = bucketStart[b]!;
      bucketStart[b] = prefix;
      prefix += c;
    }
    bucketStart[BUCKET_COUNT] = prefix; // 最后一桶的查询终点;scatter 只推进 0..N-1,此值不变。
    // scatter 游标写入桶尾段;完成后 bucketStart[b]..cursor(b) 即桶内稳定升序。
    for (let f = 0; f < total; f += 1) {
      order[bucketStart[bucketOfParticle[f]!]!] = f;
      bucketStart[bucketOfParticle[f]!]! += 1;
    }
    // 还原桶起点;查询终点存于 bucketStart[b+1](scatter 后的原 prefix 链)。
    let previous = 0;
    for (let b = 0; b < BUCKET_COUNT; b += 1) {
      const end = bucketStart[b]!;
      bucketStart[b] = previous;
      previous = end;
    }
    for (let f = 0; f < total; f += 1) {
      const setA = sets[setIndex[f]!]!;
      const i = particleIndex[f]!;
      if (setA.inverseMass[i] === 0) continue;
      const ci = cellX[f]!; const cy = cellY[f]!; const cz = cellZ[f]!;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const b = bucketOf(ci + dx, cy + dy, cz + dz);
            const end = bucketStart[b + 1]!;
            for (let idx = bucketStart[b]!; idx < end; idx += 1) {
              const g = order[idx]!;
              if (g <= f) continue;
              const setB = sets[setIndex[g]!]!;
              if (crossOnly && setB === setA) continue;
              const j = particleIndex[g]!;
              if (setB.inverseMass[j] === 0) continue;
              if (setB === setA && setA.skipPair && setA.skipPair(i, j)) continue;
              // cell 复核:hash 冲突的远粒子不算候选,同时保证每对只处理一次。
              if (cellX[g] !== ci + dx || cellY[g] !== cy + dy || cellZ[g] !== cz + dz) continue;
              const ddx = setA.px[i]! - setB.px[j]!; const ddy = setA.py[i]! - setB.py[j]!; const ddz = setA.pz[i]! - setB.pz[j]!;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 >= diameterSq) continue;
              const wi = setA.inverseMass[i]!; const wj = setB.inverseMass[j]!;
              const denom = wi + wj;
              if (denom === 0) continue;
              if (d2 === 0) {
                // 完全重合:按固定 ±X 分离,保证确定性。
                setA.px[i] = setA.px[i]! - wi * diameter / denom;
                setB.px[j] = setB.px[j]! + wj * diameter / denom;
                continue;
              }
              const len = Math.sqrt(d2);
              const push = (diameter - len) / len / denom;
              setA.px[i] = setA.px[i]! + ddx * push * wi; setA.py[i] = setA.py[i]! + ddy * push * wi; setA.pz[i] = setA.pz[i]! + ddz * push * wi;
              setB.px[j] = setB.px[j]! - ddx * push * wj; setB.py[j] = setB.py[j]! - ddy * push * wj; setB.pz[j] = setB.pz[j]! - ddz * push * wj;
            }
          }
        }
      }
    }
  } };
}

/** 单集合自碰撞包装:位置/质量缓冲引用逐次换入(零拷贝)。 */
export function createClothSelfCollision(config: ClothSelfCollisionConfig): ClothSelfCollisionResolver {
  const count = config.count;
  const radius = config.radius;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`ClothSelfCollision: count must be an integer >= 1, got ${config.count}.`);
  }
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`ClothSelfCollision: radius must be positive finite, got ${config.radius}.`);
  }
  const buffers: { -readonly [K in keyof ParticleSeparationSet]: ParticleSeparationSet[K] } = {
    px: new Float64Array(0), py: new Float64Array(0), pz: new Float64Array(0),
    inverseMass: new Float64Array(0), count,
  };
  const separation = createParticleSeparation({ sets: [buffers], diameter: 2 * radius, crossOnly: false });
  return { resolve(px, py, pz, inverseMass): void {
    buffers.px = px;
    buffers.py = py;
    buffers.pz = pz;
    buffers.inverseMass = inverseMass;
    separation.resolve();
  } };
}
