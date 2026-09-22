/**
 * F3 探针网格烘焙聚合数学（纯函数，脱离 GPU 可测）：GPU 编排服务
 * （probeGridBakeService.ts）的数值核心。
 *
 * == 职责切分 ==
 * - `planProbeGridCapture`：网格参数（origin/spacing/gridSize，单层）→ 捕获计划（每 cell
 *   一个探针位置 + 捕获纹理 2d-array 布局）。校验口径与 Native 打包器
 *   `packNativeProbeGridRecords` 同源（gridSize 每轴 2..64、体积预算、spacing/origin 范围），
 *   非法输入在请求 GPU 之前 fail-closed。
 * - `probeGridReadbackLayout` / `decodeProbeGridCapture`：捕获纹理读回布局（bytesPerRow
 *   按 WebGPU 256B 对齐）与 rgba16float half 流 → 捕获样本表（每 cell 一条 rgb + 覆盖标志）。
 *   读回模式与 webgpu/environmentAmbientReader 同款（storage 纹理 → COPY_SRC → MAP_READ）。
 * - `aggregateProbeGridBake`：捕获样本表 → 网格条目（每 cell 一条 irradiance + validity），
 *   输出与 apps/web `compileSceneRuntimePackage` options.irradianceProbes 的单层
 *   `SceneIrradianceProbeGridBake` 结构逐字段兼容（probes 元素即 deep-engine 的
 *   `RuntimeIrradianceProbe`）。validity 依据捕获覆盖：内核 texel alpha=1 为有效捕获
 *   （miss 方向记环境项也是有效观测），溢出/未覆盖 cell 写 validity 0。缺失 cell 不虚构
 *   辐射（irradiance [0,0,0] + validity 0）；越界/重复样本 fail loud。
 *
 * == 诚实边界 ==
 * 捕获纹理无距离通道，本切片 meanDistance/distanceVariance 输出 0（语义 = 无距离信息，
 * 不是"零距离"）；纯函数已接受显式距离样本，供后续切片供给后聚合。级联多层
 * （SceneIrradianceProbeCascadeBake）不在本切片。
 */

import { NATIVE_PROBE_GRID_MAX_PROBES } from "../lighting/nativeProbeGridPacker.js";
import type { RuntimeIrradianceProbe } from "../runtimePackage/environmentTypes.js";

/** 烘焙目标网格（单层）。与 SceneIrradianceProbeGridBake 的网格三元组同形。 */
export interface ProbeGridBakeGrid {
  /** 网格 cell (0,0,0) 的世界坐标（作者坐标系，与烘焙场景一致）。 */
  readonly origin: readonly [number, number, number];
  /** 相邻 cell 探针间距（世界单位，> 0）。 */
  readonly spacing: number;
  /** 三轴 cell 数（每轴整数 2..64，与 Native 打包器合同一致）。 */
  readonly gridSize: readonly [number, number, number];
}

/** 单个 cell 的捕获样本（GPU 读回解码产物；聚合纯函数的输入行）。 */
export interface ProbeGridCaptureSample {
  /** 样本所属 cell（网格局部坐标，必须落在 gridSize 内）。 */
  readonly cell: readonly [number, number, number];
  /** 捕获辐射（方向均值，线性 RGB；miss 方向已由内核计入环境项）。 */
  readonly irradiance: readonly [number, number, number];
  /** 捕获覆盖：内核 texel alpha=1；false 表示该探针溢出/未覆盖（输出 validity 0）。 */
  readonly covered: boolean;
  /** 可选距离样本（本切片捕获纹理无距离通道，GPU 路径不带；纯函数支持后续切片供给）。 */
  readonly meanDistance?: number;
  readonly distanceVariance?: number;
}

/** 捕获计划：把网格映射进捕获纹理 2d-array（texel=(x,y)，layer=z，单层 level 0）。 */
export interface ProbeGridCapturePlan {
  readonly grid: ProbeGridBakeGrid;
  /** 捕获纹理尺寸（2d-array：宽 gridSize[0]、高 gridSize[1]、层数 gridSize[2]）。 */
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  /** cell 总数 = 三轴乘积（与探针记录数一致）。 */
  readonly probeCount: number;
  /**
   * 逐 cell 的捕获计划行（linearIndex = (z*gridY + y)*gridX + x，与 Native 探针记录
   * 线性下标合同一致）。形状覆盖 encodeSourceRadiance 消费的 ProbeUpdate 字段子集。
   */
  readonly updates: readonly {
    readonly level: 0;
    readonly cell: readonly [number, number, number];
    readonly localCell: readonly [number, number, number];
    readonly linearIndex: number;
    readonly position: readonly [number, number, number];
    readonly reason: "initial";
  }[];
}

/** 烘焙产物：与 apps/web compileSceneRuntimePackage options.irradianceProbes 单层形态结构兼容。 */
export interface ProbeGridBake {
  readonly origin: readonly [number, number, number];
  readonly spacing: number;
  readonly gridSize: readonly [number, number, number];
  /** 按线性下标 (z*gridY + y)*gridX + x 排列，长度恰为网格体积。 */
  readonly probes: readonly RuntimeIrradianceProbe[];
}

/** 读回缓冲布局（copyTextureToBuffer 的 CPU 侧镜像；bytesPerRow 必须 256B 对齐）。 */
export interface ProbeGridReadbackLayout {
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly bytesPerRow: number;
  readonly rowsPerImage: number;
}

/**
 * 网格 → 捕获计划。校验与 packNativeProbeGridRecords.validateLevel 同口径（提前到
 * 请求 GPU 之前 fail-closed）：spacing ∈ (0, 1e6]、origin 有限且 |·| ≤ 1e9、gridSize
 * 每轴整数 2..64、体积 ≤ Native 探针预算。纯函数：同输入产出深相等（且冻结）的计划。
 */
export function planProbeGridCapture(grid: ProbeGridBakeGrid): ProbeGridCapturePlan {
  const [gx, gy, gz] = grid.gridSize;
  if (!(Number.isFinite(grid.spacing) && grid.spacing > 0 && grid.spacing <= 1_000_000)) {
    throw new RangeError(`probe-grid-bake: invalid-spacing ${grid.spacing}`);
  }
  if (!grid.origin.every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000_000)) {
    throw new RangeError("probe-grid-bake: invalid-origin");
  }
  if (![gx, gy, gz].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 64)) {
    throw new RangeError(`probe-grid-bake: invalid-grid-size ${JSON.stringify(grid.gridSize)}`);
  }
  const probeCount = gx * gy * gz;
  if (probeCount > NATIVE_PROBE_GRID_MAX_PROBES) {
    throw new RangeError(`probe-grid-bake: probe-budget-exceeded ${probeCount}`);
  }
  const maxPosition: readonly [number, number, number] = [
    grid.origin[0] + gx * grid.spacing, grid.origin[1] + gy * grid.spacing, grid.origin[2] + gz * grid.spacing];
  if (!maxPosition.every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000_000)) {
    throw new RangeError("probe-grid-bake: invalid-origin (grid extent)");
  }
  const freeze3 = (value: readonly number[]): readonly [number, number, number] =>
    Object.freeze([value[0], value[1], value[2]]) as readonly [number, number, number];
  const updates: {
    readonly level: 0;
    readonly cell: readonly [number, number, number];
    readonly localCell: readonly [number, number, number];
    readonly linearIndex: number;
    readonly position: readonly [number, number, number];
    readonly reason: "initial";
  }[] = [];
  // 线性序 z 最慢、x 最快，与探针记录下标合同一致；捕获层 = z（单层 level 0）。
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        updates.push(Object.freeze({
          level: 0 as const,
          cell: Object.freeze([x, y, z]) as readonly [number, number, number],
          localCell: Object.freeze([x, y, z]) as readonly [number, number, number],
          linearIndex: (z * gy + y) * gx + x,
          position: freeze3([grid.origin[0] + x * grid.spacing, grid.origin[1] + y * grid.spacing,
            grid.origin[2] + z * grid.spacing]),
          reason: "initial" as const,
        }));
      }
    }
  }
  return Object.freeze({
    grid: Object.freeze({ origin: freeze3(grid.origin), spacing: grid.spacing,
      gridSize: freeze3(grid.gridSize) }),
    width: gx, height: gy, layers: gz, probeCount, updates: Object.freeze(updates),
  });
}

/** 读回布局：rgba16float 每 texel 8B，bytesPerRow 向上对齐到 WebGPU 的 256B。 */
export function probeGridReadbackLayout(width: number, height: number, layers: number):
  ProbeGridReadbackLayout {
  const stride = width * 8;
  const bytesPerRow = Math.ceil(stride / 256) * 256;
  return Object.freeze({ width, height, layers, bytesPerRow, rowsPerImage: height });
}

/** rgba16float half word → f32（次正规/正规/无穷；NaN 视为损坏由调用方拒绝）。 */
export function decodeHalfFloat(word: number): number {
  const sign = (word & 0x8000) >>> 15;
  const exponent = (word & 0x7c00) >> 10;
  const fraction = word & 0x03ff;
  if (exponent === 0) return (sign ? -1 : 1) * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? Number.NaN : (sign ? -1 : 1) * Number.POSITIVE_INFINITY;
  return (sign ? -1 : 1) * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * 捕获纹理读回 half 流 → 样本表。布局：texel(x,y,z) 位于
 * z*bytesPerRow*rowsPerImage + y*bytesPerRow + x*8，rgba 各一个 half word。
 * 覆盖标志取 alpha half ≠ 0（内核有效捕获写 1.0、溢出写 0.0）。NaN/Inf 辐射值视为
 * 读回损坏 fail loud（内核只写有限 Lambert/环境值或全零，出现非有限值即布局/设备异常）。
 */
export function decodeProbeGridCapture(words: Uint16Array, layout: ProbeGridReadbackLayout):
  ProbeGridCaptureSample[] {
  const { width, height, layers, bytesPerRow, rowsPerImage } = layout;
  const lastByte = (layers - 1) * bytesPerRow * rowsPerImage + (height - 1) * bytesPerRow + width * 8;
  if (words.byteLength < lastByte) {
    throw new RangeError(`probe-grid-bake: capture readback truncated (${words.byteLength} < ${lastByte})`);
  }
  const half = (byteOffset: number): number => {
    const value = words[byteOffset >> 1]!;
    if (value === undefined) throw new RangeError(`probe-grid-bake: capture readback truncated at ${byteOffset}`);
    return value;
  };
  const samples: ProbeGridCaptureSample[] = [];
  for (let z = 0; z < layers; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const base = z * bytesPerRow * rowsPerImage + y * bytesPerRow + x * 8;
        const rgb = [0, 1, 2].map(axis => decodeHalfFloat(half(base + axis * 2)));
        if (rgb.some(value => !Number.isFinite(value))) {
          throw new RangeError(`probe-grid-bake: non-finite captured radiance at cell (${x},${y},${z})`);
        }
        const alpha = decodeHalfFloat(half(base + 6));
        if (Number.isNaN(alpha)) {
          throw new RangeError(`probe-grid-bake: corrupt coverage half at cell (${x},${y},${z})`);
        }
        samples.push(Object.freeze({
          cell: Object.freeze([x, y, z]) as readonly [number, number, number],
          irradiance: Object.freeze(rgb) as readonly [number, number, number],
          covered: alpha !== 0,
        }));
      }
    }
  }
  return samples;
}

/**
 * 聚合（纯函数）：捕获样本表 → 网格条目。
 * - 每 cell 恰允许一条样本：重复 cell fail loud（同一 texel 供给两次即编排缺陷）；
 *   越界 cell fail loud（不能静默丢弃，否则覆盖声明失真）。
 * - 有样本：irradiance 原样透传（GPU 已做方向均值；CPU 端不做第二次加权，避免口径分叉）、
 *   validity = covered ? 1 : 0、meanDistance/distanceVariance 取样本值（缺省 0 = 本切片
 *   无距离通道）。
 * - 无样本（未供给的 cell）：irradiance [0,0,0]、validity 0——不虚构辐射，交给运行时
 *   按 validity 权重回退。
 * - 输出按线性下标排列，长度恰为网格体积，可直接作为编译器输入（单层 SceneIrradianceProbe
 *   Bake 形状）。确定性：查表映射无浮点累加，同输入逐位同输出（与样本供给顺序无关）。
 */
export function aggregateProbeGridBake(grid: ProbeGridBakeGrid,
  samples: readonly ProbeGridCaptureSample[]): ProbeGridBake {
  const [gx, gy, gz] = grid.gridSize;
  const byLinear = new Map<number, ProbeGridCaptureSample>();
  for (const sample of samples) {
    const [x, y, z] = sample.cell;
    if (![x, y, z].every((value, axis) => Number.isSafeInteger(value)
      && value >= 0 && value < grid.gridSize[axis]!)) {
      throw new RangeError(`probe-grid-bake: sample cell out of bounds (${sample.cell.join(",")})`);
    }
    const linearIndex = (z! * gy + y!) * gx + x!;
    if (byLinear.has(linearIndex)) {
      throw new RangeError(`probe-grid-bake: duplicate sample for cell (${sample.cell.join(",")})`);
    }
    byLinear.set(linearIndex, sample);
  }
  const probes: RuntimeIrradianceProbe[] = [];
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        const sample = byLinear.get((z * gy + y) * gx + x);
        if (!sample) {
          probes.push(Object.freeze({ irradiance: Object.freeze([0, 0, 0]) as readonly [number, number, number],
            validity: 0, meanDistance: 0, distanceVariance: 0 }));
          continue;
        }
        if (sample.irradiance.some(value => !Number.isFinite(value) || value < 0)) {
          throw new RangeError(`probe-grid-bake: invalid irradiance at cell (${x},${y},${z})`);
        }
        probes.push(Object.freeze({
          irradiance: Object.freeze([...sample.irradiance]) as readonly [number, number, number],
          validity: sample.covered ? 1 : 0,
          // 本切片捕获纹理无距离通道：GPU 路径两条距离字段恒为缺省 0（无距离信息）。
          meanDistance: sample.meanDistance ?? 0,
          distanceVariance: sample.distanceVariance ?? 0,
        }));
      }
    }
  }
  return Object.freeze({
    origin: Object.freeze([...grid.origin]) as readonly [number, number, number],
    spacing: grid.spacing,
    gridSize: Object.freeze([...grid.gridSize]) as readonly [number, number, number],
    probes: Object.freeze(probes),
  });
}
