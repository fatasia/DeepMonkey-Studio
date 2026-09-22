import { beforeAll, describe, expect, it } from "vitest";
import {
  aggregateProbeGridBake, decodeHalfFloat, decodeProbeGridCapture, planProbeGridCapture,
  probeGridReadbackLayout, type ProbeGridBakeGrid, type ProbeGridCaptureSample,
} from "./probeGridBakeMath.js";
import { ProbeGridBakeService } from "./probeGridBakeService.js";
import { packNativeProbeGridRecords } from "../lighting/nativeProbeGridPacker.js";

// producer 构造读取 GPUShaderStage/GPUBufferUsage 全局（真浏览器由 WebGPU 实现提供）；
// node 下补 WebGPU 规范常量值（GPUShaderStage.COMPUTE=4；usage 位与规范一致）。
beforeAll(() => {
  const globals = globalThis as { GPUShaderStage?: unknown; GPUBufferUsage?: unknown; GPUTextureUsage?: unknown };
  globals.GPUShaderStage ??= { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 };
  globals.GPUBufferUsage ??= { MAP_READ: 0x01, MAP_WRITE: 0x02, COPY_SRC: 0x04, COPY_DST: 0x08,
    INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200 };
  globals.GPUTextureUsage ??= { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10 };
});

const GRID: ProbeGridBakeGrid = { origin: [1, 2, 3], spacing: 2, gridSize: [2, 2, 2] };

/** 最小 stub：producer 构造只建 shader module/pipeline/常量缓冲，不需要真 GPUDevice。 */
function stubDevice(): GPUDevice {
  return {
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipeline: () => ({}),
    createBuffer: () => ({ destroy: () => undefined }),
  } as unknown as GPUDevice;
}

function fullSamples(grid: ProbeGridBakeGrid, seed = 1): ProbeGridCaptureSample[] {
  const [gx, gy, gz] = grid.gridSize;
  const samples: ProbeGridCaptureSample[] = [];
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        const k = seed + x + y * gx + z * gx * gy;
        samples.push({ cell: [x, y, z], irradiance: [k * 0.25, k * 0.5, k * 0.75], covered: true });
      }
    }
  }
  return samples;
}

describe("planProbeGridCapture", () => {
  it("把 2x2x2 网格映射成 8 个 cell 的捕获计划（位置/线性序/纹理布局）", () => {
    const plan = planProbeGridCapture(GRID);
    expect(plan.width).toBe(2); expect(plan.height).toBe(2); expect(plan.layers).toBe(2);
    expect(plan.probeCount).toBe(8);
    expect(plan.updates).toHaveLength(8);
    // 线性序：z 最慢、x 最快；位置 = origin + cell * spacing。
    expect(plan.updates.map(update => update.linearIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.updates[0]!.position).toEqual([1, 2, 3]);
    expect(plan.updates[1]!.position).toEqual([3, 2, 3]);
    expect(plan.updates[3]!.position).toEqual([3, 4, 3]);
    expect(plan.updates[7]!.position).toEqual([3, 4, 5]);
    expect(plan.updates.every(update => update.level === 0 && update.reason === "initial")).toBe(true);
    // localCell 与捕获 texel/layer 映射：(x,y) → texel、z → layer。
    // linearIndex 5 = (z*gy + y)*gx + x = (1*2 + 0)*2 + 1 → cell (1,0,1)。
    expect(plan.updates[5]!.localCell).toEqual([1, 0, 1]);
  });

  it("非法网格参数 fail-closed（spacing/origin/gridSize/体积预算）", () => {
    expect(() => planProbeGridCapture({ origin: [0, 0, 0], spacing: 0, gridSize: [2, 2, 2] })).toThrow(RangeError);
    expect(() => planProbeGridCapture({ origin: [0, 0, 0], spacing: -1, gridSize: [2, 2, 2] })).toThrow(RangeError);
    expect(() => planProbeGridCapture({ origin: [0, 0, 0], spacing: Number.NaN, gridSize: [2, 2, 2] })).toThrow(RangeError);
    expect(() => planProbeGridCapture({ origin: [Number.NaN, 0, 0], spacing: 1, gridSize: [2, 2, 2] })).toThrow(RangeError);
    expect(() => planProbeGridCapture({ origin: [1e12, 0, 0], spacing: 1, gridSize: [2, 2, 2] })).toThrow(RangeError);
    const badGrids: readonly [number, number, number][] = [[1, 2, 2], [2, 2, 1], [2, 2, 65], [2.5, 2, 2], [0, 2, 2]];
    for (const bad of badGrids) {
      expect(() => planProbeGridCapture({ origin: [0, 0, 0], spacing: 1, gridSize: bad })).toThrow(RangeError);
    }
    // 体积 64*64*16 = 65536 > Native 探针预算（65535），每轴仍 ≤ 64（先过轴校验）。
    expect(() => planProbeGridCapture({ origin: [0, 0, 0], spacing: 1, gridSize: [64, 64, 16] }))
      .toThrow(/probe-budget-exceeded/);
    // 网格延伸越界（origin + 体积 * spacing 超出世界范围）。
    expect(() => planProbeGridCapture({ origin: [1e9 - 1, 0, 0], spacing: 1e6, gridSize: [64, 2, 2] }))
      .toThrow(/invalid-origin/);
  });

  it("确定性：同输入产出深相等且冻结的计划", () => {
    const a = planProbeGridCapture(GRID), b = planProbeGridCapture(GRID);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.updates)).toBe(true);
    expect(Object.isFrozen(a.updates[0])).toBe(true);
  });
});

describe("probeGridReadbackLayout + decodeProbeGridCapture", () => {
  it("bytesPerRow 对齐 256（跨行/跨层 padding 步进正确）", () => {
    expect(probeGridReadbackLayout(2, 2, 2)).toMatchObject({ bytesPerRow: 256, rowsPerImage: 2 });
    expect(probeGridReadbackLayout(32, 8, 4)).toMatchObject({ bytesPerRow: 256, rowsPerImage: 8 });
    expect(probeGridReadbackLayout(33, 8, 4)).toMatchObject({ bytesPerRow: 512, rowsPerImage: 8 });
    expect(probeGridReadbackLayout(64, 64, 64)).toMatchObject({ bytesPerRow: 512, rowsPerImage: 64 });
  });

  it("从 half 流解码样本：rgb/覆盖标志/跨层步进", () => {
    const plan = planProbeGridCapture(GRID);
    const layout = probeGridReadbackLayout(plan.width, plan.height, plan.layers);
    const words = new Uint16Array(layout.bytesPerRow * layout.rowsPerImage * layout.layers / 2);
    // 每层首 texel 写可辨识 half 位模式；层内第二个 texel 保持全零 = 溢出。
    // layer 0 首通道 0.25 (0x3400)、layer 1 首通道 1.25 (0x3D00)——位模式显式给出。
    const LAYER_R = [0x3400, 0x3d00];
    for (let z = 0; z < plan.layers; z++) {
      const layerBase = z * layout.bytesPerRow * layout.rowsPerImage / 2;
      words[layerBase + 0] = LAYER_R[z]!;
      words[layerBase + 1] = 0x3800; // 0.5
      words[layerBase + 2] = 0x3a00; // 0.75
      words[layerBase + 3] = 0x3c00; // alpha 1.0
    }
    const samples = decodeProbeGridCapture(words, layout);
    expect(samples).toHaveLength(8);
    const first = samples[0]!, overflowed = samples[1]!, layerOne = samples[4]!;
    expect(first.covered).toBe(true);
    expect(first.irradiance[0]).toBeCloseTo(0.25, 3);
    expect(first.irradiance[1]).toBeCloseTo(0.5, 3);
    expect(first.irradiance[2]).toBeCloseTo(0.75, 3);
    expect(overflowed.covered).toBe(false);
    expect(layerOne.irradiance[0]).toBeCloseTo(1.25, 3);
  });

  it("非有限辐射值与截断缓冲 fail loud", () => {
    const layout = probeGridReadbackLayout(2, 2, 2);
    const words = new Uint16Array(layout.bytesPerRow * layout.rowsPerImage * layout.layers / 2);
    words[2] = 0x7c01; // NaN half（指数全 1 + 非 0 尾数）
    expect(() => decodeProbeGridCapture(words, layout)).toThrow(/non-finite/);
    expect(() => decodeProbeGridCapture(new Uint16Array(4), layout)).toThrow(/truncated/);
  });

  it("decodeHalfFloat 覆盖次正规/正规/无穷/符号", () => {
    expect(decodeHalfFloat(0)).toBe(0);
    expect(decodeHalfFloat(0x8000)).toBe(-0);
    expect(decodeHalfFloat(0x3c00)).toBe(1);
    expect(decodeHalfFloat(0xbc00)).toBe(-1);
    expect(decodeHalfFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY);
    expect(decodeHalfFloat(1)).toBeCloseTo(2 ** -24, 30); // 最小次正规
    expect(decodeHalfFloat(0x3555)).toBeCloseTo(0.33325195, 8);
  });
});

describe("aggregateProbeGridBake", () => {
  it("全覆盖：8 条样本按线性序透传为 8 条网格条目（validity 1）", () => {
    const bake = aggregateProbeGridBake(GRID, fullSamples(GRID));
    expect(bake).toMatchObject({ origin: [1, 2, 3], spacing: 2, gridSize: [2, 2, 2] });
    expect(bake.probes).toHaveLength(8);
    expect(bake.probes.every(probe => probe.validity === 1)).toBe(true);
    expect(bake.probes[3]!.irradiance).toEqual([0.25 + 3 * 0.25, 0.5 + 3 * 0.5, 0.75 + 3 * 0.75]);
    // 本切片无距离通道：GPU 路径距离字段为 0（无距离信息）。
    expect(bake.probes.every(probe => probe.meanDistance === 0 && probe.distanceVariance === 0)).toBe(true);
  });

  it("缺失 cell 输出 validity 0 + 零辐射（不虚构），越界/重复样本 fail loud", () => {
    // 移除 linearIndex 3 (1,1,0) 与 6 (0,1,1)：fullSamples 按线性序生成，下标即 linearIndex。
    const samples = fullSamples(GRID).filter((_, index) => index !== 3 && index !== 6);
    const bake = aggregateProbeGridBake(GRID, samples);
    expect(bake.probes).toHaveLength(8);
    expect(bake.probes[3]).toMatchObject({ irradiance: [0, 0, 0], validity: 0 });
    expect(bake.probes[6]).toMatchObject({ irradiance: [0, 0, 0], validity: 0 });
    expect(bake.probes.filter(probe => probe.validity === 1)).toHaveLength(6);
    expect(() => aggregateProbeGridBake(GRID,
      [{ cell: [2, 0, 0], irradiance: [1, 1, 1], covered: true }])).toThrow(/out of bounds/);
    expect(() => aggregateProbeGridBake(GRID,
      [{ cell: [-1, 0, 0], irradiance: [1, 1, 1], covered: true }])).toThrow(/out of bounds/);
    const duplicated = [...fullSamples(GRID), { cell: [0, 0, 0], irradiance: [9, 9, 9], covered: true }];
    expect(() => aggregateProbeGridBake(GRID, duplicated)).toThrow(/duplicate/);
  });

  it("空场景路径（全方向 miss = 环境项）仍是有效捕获；溢出样本（covered=false）输出 validity 0", () => {
    const ambient: ProbeGridCaptureSample[] = Array.from({ length: 8 }, (_, index) => ({
      cell: [index % 2, Math.floor(index / 2) % 2, Math.floor(index / 4)] as [number, number, number],
      irradiance: [0.05, 0.05, 0.06], covered: true }));
    const bake = aggregateProbeGridBake(GRID, ambient);
    expect(bake.probes.every(probe => probe.validity === 1)).toBe(true);
    expect(bake.probes[0]!.irradiance).toEqual([0.05, 0.05, 0.06]);
    const overflowed = fullSamples(GRID).map(sample =>
      sample.cell[0] === 1 && sample.cell[1] === 1 && sample.cell[2] === 1
        ? { ...sample, covered: false, irradiance: [0, 0, 0] as [number, number, number] } : sample);
    const mixed = aggregateProbeGridBake(GRID, overflowed);
    expect(mixed.probes[7]).toMatchObject({ irradiance: [0, 0, 0], validity: 0 });
    expect(mixed.probes[0]!.validity).toBe(1);
  });

  it("确定性：同输入逐位同输出且输出冻结", () => {
    const samples = fullSamples(GRID);
    const a = aggregateProbeGridBake(GRID, samples), b = aggregateProbeGridBake(GRID, [...samples].reverse());
    // 样本供给顺序不影响输出（查表映射，无顺序敏感累加）。
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.probes)).toBe(true);
    expect(Object.isFrozen(a.probes[0])).toBe(true);
  });

  it("显式距离样本透传（后续切片供给路径）", () => {
    const bake = aggregateProbeGridBake(GRID,
      [{ cell: [0, 0, 0], irradiance: [1, 1, 1], covered: true, meanDistance: 4.5, distanceVariance: 0.25 }]);
    expect(bake.probes[0]).toMatchObject({ meanDistance: 4.5, distanceVariance: 0.25 });
    expect(bake.probes[1]).toMatchObject({ meanDistance: 0, distanceVariance: 0 });
  });

  it("产出能通过 Native 打包器的编译器输入校验（覆盖 + 未覆盖混合）", () => {
    // compileSceneRuntimePackage 写包前调用的同一校验器；混合 validity 不得被拒。
    const bake = aggregateProbeGridBake(GRID,
      fullSamples(GRID).map(sample => sample.cell[0] === 0 && sample.cell[1] === 0 && sample.cell[2] === 0
        ? { ...sample, covered: false, irradiance: [0, 0, 0] as [number, number, number] } : sample));
    const packed = packNativeProbeGridRecords(
      { origin: bake.origin, spacing: bake.spacing, gridSize: bake.gridSize }, bake.probes);
    expect(packed.byteLength).toBe(9 * 96); // 网格头 1 + 探针 8，96B/记录
    // 缺样本 cell 聚合时已补 validity 0：输出恒为满体积，能通过打包器的数量合同。
    const incomplete = aggregateProbeGridBake(GRID, fullSamples(GRID).slice(0, 7));
    expect(incomplete.probes).toHaveLength(8);
    expect(() => packNativeProbeGridRecords(
      { origin: incomplete.origin, spacing: incomplete.spacing, gridSize: incomplete.gridSize },
      incomplete.probes)).not.toThrow();
  });
});

describe("ProbeGridBakeService 构造合同（无 GPU）", () => {
  it("光向量非法 fail-fast（复用 producer validateLighting 合同）", () => {
    expect(() => new ProbeGridBakeService(stubDevice(), {
      lighting: { ambient: [Number.NaN, 0, 0] } })).toThrow(RangeError);
    expect(() => new ProbeGridBakeService(stubDevice(), {
      lighting: { primary: { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: -1 },
        ambient: [0, 0, 0] } })).toThrow(RangeError);
  });

  it("合法构造后 dispose 幂等；dispose 后 bake 拒绝", async () => {
    const service = new ProbeGridBakeService(stubDevice(), { lighting: { ambient: [0.05, 0.05, 0.06] } });
    expect(service.disposedFlag).toBe(false);
    service.dispose();
    service.dispose();
    expect(service.disposedFlag).toBe(true);
    await expect(service.bake({} as never, GRID)).rejects.toThrow(/disposed/);
  });
});
