/**
 * Brief-GI M1 天光遮蔽:探针方向 × 场景 SDF 圆锥追踪的 CPU 权威实现。
 *
 * == 与 WGSL 单源的关系 ==
 * 公式与步进序逐式镜像 `wgsl/sdfSkyVisibilityTrace.wgsl`(生成镜像
 * sdfSkyVisibilityTraceWgsl.ts,字节门禁 + naga 校验):固定步数循环(无 early-break,
 * 同输入逐位回放)、trilinear 采样序 x4→y2→z1、`vis = min_i clamp(s_i/(limit),0,1)`、
 * `limit = max(coneTan·t, LIMIT_EPSILON)`。浮点按 fround 收敛 f32;真机 GPU 若 FMA
 * 融合,差异走容差对拍(A3 布料先例口径)。
 *
 * == 域外语义(与碰撞查询刻意不同) ==
 * 天光可见性是**光照量**不是安全量:探针在场景 SDF 域外视作「直达天空」(vis=1)而非
 * NaN/域外拒绝——烘焙域之外的世界本就是开放天空,fail-closed 会造出假影。场内永不含
 * NaN(sdfSceneBake 烘焙合同),本路径不产出也不传播非有限值。
 *
 * == 消费 ==
 * 每探针 × Fibonacci 方向集(probeOcclusionDirection,CPU 权威,不重建方向集)的可见度
 * 向量喂给 `probeSkyVisibilitySh.projectSkyVisibilitySh` 投影 L1 SH,再由
 * `probeShUpdate.updateProbeShWithSdfGi` 进探针场(时域滤波)。
 */
import { DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL, SDF_SKY_VISIBILITY_ENTRY,
  SDF_SKY_VISIBILITY_LIMIT_EPSILON, SDF_SKY_VISIBILITY_MAX_STEPS,
  SDF_SKY_VISIBILITY_MIN_STEPS, SDF_SKY_VISIBILITY_PARAMS_BYTES,
  SDF_SKY_VISIBILITY_WORKGROUP_SIZE } from "./sdfSkyVisibilityTraceWgsl.js";
import type { SdfGrid } from "../physics/sdfGrid.js";
import type { ProbeVector3 } from "../lighting/probeClipmapPlan.js";

export {
  DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL, SDF_SKY_VISIBILITY_ENTRY, SDF_SKY_VISIBILITY_LIMIT_EPSILON,
  SDF_SKY_VISIBILITY_MAX_STEPS, SDF_SKY_VISIBILITY_MIN_STEPS, SDF_SKY_VISIBILITY_PARAMS_BYTES,
  SDF_SKY_VISIBILITY_WORKGROUP_SIZE,
};

export interface SdfSkyVisibilityTraceOptions {
  /** 圆锥步数(8..16,Brief-GI 口径);缺省 8。越界 fail-closed 回边界值。 */
  readonly steps?: number;
  /** 圆锥半角正切(>0,≤1);缺省 tan(15°)≈0.2679(探针尺度软遮蔽)。 */
  readonly coneTan?: number;
  /** 追踪最大行程(米);缺省 = 场景对角线。 */
  readonly maxDistance?: number;
}

export interface SdfSkyVisibilityTraceConfig {
  readonly steps: number;
  readonly coneTan: number;
  readonly maxDistance: number;
}

const DEFAULT_CONE_TAN = Math.tan(Math.PI / 12);

/** 配置解析(fail-closed):非法值回边界,不抛错(渲染循环不因脏配置中断)。 */
export function resolveSdfSkyVisibilityTraceConfig(grid: Pick<SdfGrid, "dimensions" | "cellSize">,
  options: SdfSkyVisibilityTraceOptions = {}): SdfSkyVisibilityTraceConfig {
  const steps = clampBound(options.steps, SDF_SKY_VISIBILITY_MIN_STEPS, SDF_SKY_VISIBILITY_MAX_STEPS,
    SDF_SKY_VISIBILITY_MIN_STEPS);
  const coneTan = clampBound(options.coneTan, DEFAULT_CONE_TAN, 1, DEFAULT_CONE_TAN);
  const diagonal = Math.hypot((grid.dimensions[0] - 1) * grid.cellSize,
    (grid.dimensions[1] - 1) * grid.cellSize, (grid.dimensions[2] - 1) * grid.cellSize);
  const maxDistance = clampBound(options.maxDistance, diagonal, diagonal * 16, diagonal);
  return { steps, coneTan, maxDistance };
}

function clampBound(value: number | undefined, fallback: number, max: number, outOfRange: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > max) return outOfRange;
  return value;
}

/**
 * 圆锥追踪(CPU 权威):每 (探针 × 方向) 输出可见度 ∈[0,1],输出长度 =
 * positions.length × directions.length,下标 = probeIndex × directions.length + dirIndex。
 * 域外探针恒 1;同输入逐位同输出。
 */
export function traceSdfSkyVisibility(grid: SdfGrid, positions: readonly ProbeVector3[],
  directions: readonly ProbeVector3[], options: SdfSkyVisibilityTraceOptions = {}): Float32Array<ArrayBuffer> {
  if (!positions.length || !directions.length) {
    throw new RangeError("SDF sky visibility trace needs at least one probe and one direction.");
  }
  if (!directions.every(direction => direction.length === 3 && direction.every(Number.isFinite))) {
    throw new RangeError("SDF sky visibility directions must be finite vec3.");
  }
  const config = resolveSdfSkyVisibilityTraceConfig(grid, options);
  const fround = Math.fround;
  const unit = directions.map(direction => {
    const x = fround(direction[0]!), y = fround(direction[1]!), z = fround(direction[2]!);
    const length = fround(Math.sqrt(fround(fround(x * x) + fround(fround(y * y) + fround(z * z)))));
    return [fround(x / length), fround(y / length), fround(z / length)] as ProbeVector3;
  });
  const [nx, ny, nz] = grid.dimensions;
  const maxX = nx - 1, maxY = ny - 1, maxZ = nz - 1;
  const cs = grid.cellSize, origin = grid.origin;
  const at = (x: number, y: number, z: number): number => grid.distances[
    (Math.min(Math.max(z, 0), maxZ) * ny + Math.min(Math.max(y, 0), maxY)) * nx
    + Math.min(Math.max(x, 0), nx - 1)]!;
  const sample = (px: number, py: number, pz: number): number => {
    const qx = fround(fround(px - origin[0]!) / cs);
    const qy = fround(fround(py - origin[1]!) / cs);
    const qz = fround(fround(pz - origin[2]!) / cs);
    // 域外 = 开放空间(与 WGSL 同字面:1e6,可见性贡献恒 1;绝不把边界环的
    // 近零距离泄漏到域外,否则天空方向全部被假遮蔽)。
    if (qx < 0 || qy < 0 || qz < 0 || qx > maxX || qy > maxY || qz > maxZ) return 1_000_000;
    const cx = Math.min(Math.max(qx, 0), maxX), cy = Math.min(Math.max(qy, 0), maxY),
      cz = Math.min(Math.max(qz, 0), maxZ);
    const lx = Math.floor(cx), ly = Math.floor(cy), lz = Math.floor(cz);
    const fx = fround(cx - lx), fy = fround(cy - ly), fz = fround(cz - lz);
    const d000 = at(lx, ly, lz), d100 = at(lx + 1, ly, lz);
    const d010 = at(lx, ly + 1, lz), d110 = at(lx + 1, ly + 1, lz);
    const d001 = at(lx, ly, lz + 1), d101 = at(lx + 1, ly, lz + 1);
    const d011 = at(lx, ly + 1, lz + 1), d111 = at(lx + 1, ly + 1, lz + 1);
    const x0 = fround(d000 + fround(fround(d100 - d000) * fx));
    const x1 = fround(d010 + fround(fround(d110 - d010) * fx));
    const x2 = fround(d001 + fround(fround(d101 - d001) * fx));
    const x3 = fround(d011 + fround(fround(d111 - d011) * fx));
    const y0 = fround(x0 + fround(fround(x1 - x0) * fy));
    const y1 = fround(x2 + fround(fround(x3 - x2) * fy));
    return fround(y0 + fround(fround(y1 - y0) * fz));
  };
  const out = new Float32Array(positions.length * directions.length);
  const stride = directions.length;
  const stepLength = fround(config.maxDistance / config.steps);
  for (let probe = 0; probe < positions.length; probe++) {
    const position = positions[probe]!;
    const inDomain = [0, 1, 2].every(axis => {
      const q = fround(fround(position[axis]! - origin[axis]!) / cs);
      return q >= 0 && q <= [maxX, maxY, maxZ][axis]!;
    });
    for (let direction = 0; direction < stride; direction++) {
      if (!inDomain) { out[probe * stride + direction] = 1; continue; }
      const [dx, dy, dz] = unit[direction]!;
      let visibility = 1;
      for (let step = 0; step < config.steps; step++) {
        const t = fround(fround(step + 0.5) * stepLength);
        const sx = sample(fround(position[0]! + fround(dx * t)),
          fround(position[1]! + fround(dy * t)), fround(position[2]! + fround(dz * t)));
        const limit = Math.max(fround(config.coneTan * t), SDF_SKY_VISIBILITY_LIMIT_EPSILON);
        const contribution = Math.min(1, Math.max(0, sx / limit));
        visibility = Math.min(visibility, contribution);
      }
      out[probe * stride + direction] = visibility;
    }
  }
  return out;
}
