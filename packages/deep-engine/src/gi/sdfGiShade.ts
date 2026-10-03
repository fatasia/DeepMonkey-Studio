import { sampleIrradianceProbeClipmap } from "../lighting/probeClipmapSampling.js";
import type { ProbeVector3 } from "../lighting/probeClipmapPlan.js";
import type { SdfGiDayNightState } from "./sdfGiDayNight.js";

/**
 * Brief-GI M1 昼夜 harness 的着色端:对烘焙的场景 SDF 做球面追踪主射线,
 * 表面项 = 反照率 × 探针 GI(sampleIrradianceProbeClipmap,泄露哨兵链同源),
 * 背景项 = 物理天空。**刻意不含直射项**:动态直接层的生产通路(SDGDI/直射 pass)
 * 不属 M1,像素门只隔离本刀新增链路(场景 SDF 圆锥遮蔽 + 探针 SH 更新 + 时域滤波)
 * 的时域稳定性;直射的 crisp 阴影由既有直射通路承载。
 *
 * 这是 CPU 参考渲染(验收证据发生器),不是生产渲染通路。
 */

export interface SdfGiCamera {
  readonly position: ProbeVector3;
  readonly target: ProbeVector3;
  /** 垂直视场角(度)。 */
  readonly fovDegrees: number;
}

export const SDF_GI_DEFAULT_CAMERA: SdfGiCamera = {
  position: [1.2, 2.2, 4.8], target: [5, 1, 2], fovDegrees: 55,
};

export interface SdfGiFrameShadeInput {
  readonly width: number;
  readonly height: number;
  readonly camera: SdfGiCamera;
  /** 天空背景采样(ENU 方向 → 线性 RGB;GI 场的 miss/背景同源)。 */
  readonly skyRadiance: (directionEnu: ProbeVector3) => ProbeVector3;
  /** 显示曝光增益(线性域乘子;缺省 1)。 */
  readonly exposure?: number;
}

export interface SdfGiFrame {
  /** RGBA8(行主,width×height×4)。 */
  readonly rgba: Uint8Array<ArrayBuffer>;
  /** 主射线命中率(证据:覆盖率)。 */
  readonly hitRatio: number;
}

const MAX_PRIMARY_STEPS = 128;
const MAX_TRACE_DISTANCE = 40;
const SURFACE_EPSILON = 0.0015;
/** 探针 GI 采样抬升(防自遮挡;与泄露哨兵半步同族)。 */
const GI_LIFT = 0.06;

/** 渲染一帧(球面追踪 + 探针 GI + 物理天空背景;零热路径分配)。 */
export function shadeSdfGiFrame(state: SdfGiDayNightState, input: SdfGiFrameShadeInput): SdfGiFrame {
  const { width, height, camera } = input;
  const rgba = new Uint8Array(width * height * 4);
  const grid = state.bake.grid;
  const [nx, ny, nz] = grid.dimensions;
  const ox = grid.origin[0], oy = grid.origin[1], oz = grid.origin[2];
  const cs = grid.cellSize, field = grid.distances;
  const maxX = nx - 1, maxY = ny - 1, maxZ = nz - 1;
  const at = (x: number, y: number, z: number): number =>
    field[(Math.min(Math.max(z, 0), maxZ) * ny + Math.min(Math.max(y, 0), maxY)) * nx
      + Math.min(Math.max(x, 0), nx - 1)]!;
  const distanceAt = (px: number, py: number, pz: number): number => {
    const qx = (px - ox) / cs, qy = (py - oy) / cs, qz = (pz - oz) / cs;
    if (qx < 0 || qy < 0 || qz < 0 || qx > maxX || qy > maxY || qz > maxZ) return 1e6;
    const lx = Math.floor(qx), ly = Math.floor(qy), lz = Math.floor(qz);
    const fx = qx - lx, fy = qy - ly, fz = qz - lz;
    const d000 = at(lx, ly, lz), d100 = at(lx + 1, ly, lz);
    const d010 = at(lx, ly + 1, lz), d110 = at(lx + 1, ly + 1, lz);
    const d001 = at(lx, ly, lz + 1), d101 = at(lx + 1, ly, lz + 1);
    const d011 = at(lx, ly + 1, lz + 1), d111 = at(lx + 1, ly + 1, lz + 1);
    const x0 = d000 + (d100 - d000) * fx, x1 = d010 + (d110 - d010) * fx;
    const x2 = d001 + (d101 - d001) * fx, x3 = d011 + (d111 - d011) * fx;
    const y0 = x0 + (x1 - x0) * fy, y1 = x2 + (x3 - x2) * fy;
    return y0 + (y1 - y0) * fz;
  };
  const forward = normalize3(sub3(camera.target, camera.position));
  const right = normalize3(cross3(forward, [0, 1, 0]));
  const up = cross3(right, forward);
  const tanHalf = Math.tan(camera.fovDegrees * Math.PI / 360);
  const giLevels = [state.level];
  let hits = 0;
  for (let y = 0; y < height; y++) {
    const v = (1 - (y + 0.5) / height * 2) * tanHalf;
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width * 2 - 1) * tanHalf;
      const dx = forward[0] + right[0] * u + up[0] * v;
      const dy = forward[1] + right[1] * u + up[1] * v;
      const dz = forward[2] + right[2] * u + up[2] * v;
      const length = Math.hypot(dx, dy, dz);
      const dirX = dx / length, dirY = dy / length, dirZ = dz / length;
      const offset = (y * width + x) * 4;
      let travel = 0;
      let hitX = 0, hitY = 0, hitZ = 0, hit = false;
      for (let step = 0; step < MAX_PRIMARY_STEPS; step++) {
        const px = camera.position[0] + dirX * travel;
        const py = camera.position[1] + dirY * travel;
        const pz = camera.position[2] + dirZ * travel;
        const distance = distanceAt(px, py, pz);
        if (distance < SURFACE_EPSILON) {
          hitX = px; hitY = py; hitZ = pz; hit = true;
          break;
        }
        travel += Math.min(distance * 0.95, 1);
        if (travel > MAX_TRACE_DISTANCE) break;
      }
      let color: ProbeVector3;
      if (!hit) {
        const invLength = 1 / Math.hypot(dirX, dirY, dirZ);
        color = input.skyRadiance([dirX * invLength, dirZ * invLength, dirY * invLength]);
      } else {
        hits += 1;
        // 中心差分法线(SURFACE_EPSILON 邻域;域边钳制由 at() 承担):
        const h = grid.cellSize * 0.5;
        const gx = distanceAt(hitX + h, hitY, hitZ) - distanceAt(hitX - h, hitY, hitZ);
        const gy = distanceAt(hitX, hitY + h, hitZ) - distanceAt(hitX, hitY - h, hitZ);
        const gz = distanceAt(hitX, hitY, hitZ + h) - distanceAt(hitX, hitY, hitZ - h);
        const normal = normalize3([gx, gy, gz]);
        const albedo = nearestAlbedo(state, [hitX, hitY, hitZ]);
        const gi = sampleIrradianceProbeClipmap({
          worldPosition: [hitX + normal[0] * GI_LIFT, hitY + normal[1] * GI_LIFT,
            hitZ + normal[2] * GI_LIFT],
          worldNormal: normal, levels: giLevels, records: state.records,
          environmentFallback: [0, 0, 0],
        });
        color = [albedo[0] * gi.irradiance[0]!, albedo[1] * gi.irradiance[1]!,
          albedo[2] * gi.irradiance[2]!];
      }
      const exposure = input.exposure ?? 1;
      rgba[offset] = toSrgb8(color[0] * exposure);
      rgba[offset + 1] = toSrgb8(color[1] * exposure);
      rgba[offset + 2] = toSrgb8(color[2] * exposure);
      rgba[offset + 3] = 255;
    }
  }
  return { rgba, hitRatio: hits / (width * height) };
}

/** 命中点反照率:参考房间盒查询(与烘焙源同一场,防双源漂移)。 */
function nearestAlbedo(state: SdfGiDayNightState, point: ProbeVector3): ProbeVector3 {
  let best = state.scene.boxes[0]!, bestDistance = Infinity;
  for (const box of state.scene.boxes) {
    const dx = Math.max(box.min[0] - point[0], 0, point[0] - box.max[0]);
    const dy = Math.max(box.min[1] - point[1], 0, point[1] - box.max[1]);
    const dz = Math.max(box.min[2] - point[2], 0, point[2] - box.max[2]);
    const distance = Math.hypot(dx, dy, dz);
    if (distance < bestDistance) { bestDistance = distance; best = box; }
  }
  return best.albedo;
}

/** 逐帧像素差 p99(8-bit 域,RGB 通道;验收①口径)。 */
export function frameDiffP99(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length % 4 !== 0 || a.length === 0) {
    throw new RangeError("Frame diff requires equal non-empty RGBA buffers.");
  }
  const diffs: number[] = [];
  for (let index = 0; index < a.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      diffs.push(Math.abs(a[index + channel]! - b[index + channel]!));
    }
  }
  diffs.sort((left, right) => left - right);
  return diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.99))]!;
}

function toSrgb8(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const srgb = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
}

function sub3(a: ProbeVector3, b: ProbeVector3): ProbeVector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: ProbeVector3, b: ProbeVector3): ProbeVector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(value: ProbeVector3): ProbeVector3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-8 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 1, 0];
}
