import { describe, expect, it } from "vitest";
import { softBodyParallelDispatchCount } from "./softBodyGpuDispatch.softbodyParallel.js";
import { packSoftBodyGpuParticles, packSoftBodyGpuEdges, packSoftBodyGpuTets, packSoftBodyGpuParams,
  SOFT_BODY_GPU_PARAMS_BYTES } from "./softBodyGpuWgsl.js";

const input = {
  particles: [
    { position: [0, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
    { position: [1, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
    { position: [0, 1, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
    { position: [0, 0, 1] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
  ],
  edges: [{ a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }],
  tets: [{ i0: 0, i1: 1, i2: 2, i3: 3, restVolume: 1 / 6 }],
  dtSeconds: 1 / 60, substeps: 4, complianceDistance: 0, complianceVolume: 0,
  damping: 0.01, gravity: [0, -9.81, 0] as const,
};

describe("软体并行编排(CPU 合同;真机第三刀)", () => {
  it("pack 布局与串行核完全一致(共享 ABI)", () => {
    const particles = packSoftBodyGpuParticles(input.particles);
    expect(particles.length).toBe(input.particles.length * 12);
    expect(packSoftBodyGpuEdges(input.edges, input.particles.length).byteLength).toBe(input.edges.length * 16);
    expect(packSoftBodyGpuTets(input.tets, input.particles.length).byteLength).toBe(input.tets.length * 32);
    const params = packSoftBodyGpuParams(input);
    expect(params.byteLength).toBe(SOFT_BODY_GPU_PARAMS_BYTES); // 风场刀 96B;头 48B 同旧 ABI
    const ints = new Uint32Array(params);
    expect([ints[0], ints[1], ints[2], ints[3]]).toEqual([4, 2, 1, 4]);
    // 零风退化:风槽(尾 48B)全零,头 48B 与旧 48B 合同逐位一致。
    expect(Array.from(new Uint32Array(params, 48))).toEqual(new Array<number>(12).fill(0));
  });

  it("编排计数 = substeps×(2+边色数+体积色数[+有障碍+1])", () => {
    expect(softBodyParallelDispatchCount(4, 2, 1)).toBe(4 * 5);
    expect(softBodyParallelDispatchCount(8, 1, 1)).toBe(8 * 4);
    expect(softBodyParallelDispatchCount(4, 2, 1, 1)).toBe(4 * 7);
    expect(softBodyParallelDispatchCount(4, 2, 1, 0)).toBe(4 * 5);
    expect(softBodyParallelDispatchCount(8, 1, 1, 64)).toBe(8 * 6);
  });
});

import { mirrorSoftBodyGpuStep } from "./softBodyGpuWgsl.js";
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "./softBodyVolumeColoring.js";
import { dispatchSoftBodyParallelGpuStep, mirrorSoftBodyParallelStep } from "./softBodyGpuDispatch.softbodyParallel.js";
import { SOFT_BODY_PARALLEL_ENTRY_INTEGRATE, SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES,
  SOFT_BODY_PARALLEL_SOLVER_WGSL } from "./softBodyParallelSolverWgsl.js";
import { SOFT_BODY_GPU_MAX_OBSTACLES } from "./softBodyGpuWgsl.js";

describe("色批序镜像(第三刀)", () => {
  it("单约束退化:色数 1 时与串行镜像逐位一致(投影序相同)", () => {
    const single = { ...input, edges: [input.edges[0]!], tets: [] };
    const edgeColoring = colorClothConstraints([single.edges[0]!.a], [single.edges[0]!.b], single.particles.length);
    const volumeColoring = colorSoftBodyVolumes([], single.particles.length);
    const parallel = mirrorSoftBodyParallelStep(single, edgeColoring, volumeColoring);
    const serial = mirrorSoftBodyGpuStep(single);
    expect(Array.from(parallel)).toEqual(Array.from(serial));
  });

  it("多约束:投影序不同→数值接近(容差 1e-5,单 tick),双跑逐位", () => {
    const one = mirrorSoftBodyParallelStep(input, colorClothConstraints(input.edges.map(e => e.a), input.edges.map(e => e.b), 4), colorSoftBodyVolumes(input.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), 4));
    const two = mirrorSoftBodyParallelStep(input, colorClothConstraints(input.edges.map(e => e.a), input.edges.map(e => e.b), 4), colorSoftBodyVolumes(input.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), 4));
    expect(Array.from(one)).toEqual(Array.from(two)); // 双跑逐位(无随机源)
    const serial = mirrorSoftBodyGpuStep(input);
    let maxDiff = 0;
    for (let i = 0; i < one.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(one[i]! - serial[i]!));
    expect(maxDiff).toBeLessThanOrEqual(1e-5); // 投影序不同,同 tick 数值接近
  });
});

// —— F6/T18 障碍刀:CPU 合同(fake device 编排 + 无障碍逐位退化 + 障碍接触完整性)——

// Node 测试环境无 WebGPU 全局:垫最小枚举 shim(数值与规范一致,fake 只做 trace/字节判断)。
const GPU_ENUMS = {
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1, WRITE: 2 },
} as const;
for (const [key, value] of Object.entries(GPU_ENUMS)) (globalThis as Record<string, unknown>)[key] ??= value;

function fakeDevice(): { device: GPUDevice; buffers: Array<{ size: number; usage: number; written: ArrayBuffer | null; destroyed: boolean }>; trace: string[] } {
  const buffers: Array<{ size: number; usage: number; written: ArrayBuffer | null; destroyed: boolean }> = [];
  const trace: string[] = [];
  const device = {
    createBuffer: (descriptor: { size: number; usage: number }) => {
      const buffer = {
        size: descriptor.size, usage: descriptor.usage, written: null as ArrayBuffer | null, destroyed: false,
        mapAsync: async () => {}, unmap: () => {}, getMappedRange: () => new ArrayBuffer(descriptor.size), destroy: () => { buffer.destroyed = true; },
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer: (buffer: { written: ArrayBuffer | null }, offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
        expect(offset).toBe(0);
        buffer.written = data instanceof ArrayBuffer
          ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
      submit: () => { for (const b of buffers) if (b.usage & GPUBufferUsage.MAP_READ) (b as unknown as { mapState?: string }).mapState = "mapped"; },
    },
    createShaderModule: (descriptor: { code: string }) => {
      expect(descriptor.code).toBe(SOFT_BODY_PARALLEL_SOLVER_WGSL);
      return { code: descriptor.code, getCompilationInfo: async () => ({ messages: [] }) };
    },
    createComputePipelineAsync: async (descriptor: { compute: { entryPoint: string } }) => ({ entryPoint: descriptor.compute.entryPoint, getBindGroupLayout: () => ({}) }),
    createBindGroup: (descriptor: { entries: Array<{ binding: number }> }) => ({ bindings: descriptor.entries.map(e => e.binding) }),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: (pipeline: { entryPoint: string }) => { trace.push(`set:${pipeline.entryPoint}`); },
        setBindGroup: () => { trace.push("bind"); },
        dispatchWorkgroups: (count: number) => { trace.push(`dispatch:${count}`); },
        end: () => { trace.push("end"); },
      }),
      copyBufferToBuffer: () => { trace.push("copy"); },
      finish: () => ({}),
    }),
  } as unknown as GPUDevice;
  return { device, buffers, trace };
}

const obstaclesInput = {
  ...input, substeps: 2,
  obstacles: [
    { center: [0.5, -0.3, 0.5] as const, radius: 0.8, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, halfExtents: [0, 0, 0] as const },
    { center: [5, 5, 5] as const, radius: 0, rotation: [0.8, -0.6, 0, 0.6, 0.8, 0, 0, 0, 1] as const, halfExtents: [0.5, 0.25, 0.125] as const },
  ],
};

describe("F6/T18 软体并行核障碍:编排与退化(fake device)", () => {
  it("有障碍编排:每子步 integrate → projectObstaclesSoftBody → 边色批 → 体积色批 → finalize;缓冲含 64×80B 障碍数据 + [count,0,0,0] range", async () => {
    const { device, buffers, trace } = fakeDevice();
    const result = await dispatchSoftBodyParallelGpuStep(device, obstaclesInput);
    const perSubstep = [
      "set:integrateParticles", "bind", "dispatch:1",
      `set:${SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES}`, "bind", "dispatch:1",
      "set:projectEdgesColor", "bind", "dispatch:1", "bind", "dispatch:1", // 2 边共端点 → 2 色
      "set:projectVolumesColor", "bind", "dispatch:1",
      `set:${SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES}`, "bind", "dispatch:1",
      "set:finalizeParticles", "bind", "dispatch:1",
    ];
    expect(trace).toEqual([...Array.from({ length: 2 }, () => perSubstep).flat(), "end", "copy"]);
    // 缓冲序:state 192 / edge 32 / tet 32 / params 96(风场刀;头 48B 同旧)/
    // 2×edgeRange 16 / volumeRange 16 / readback 192 / 障碍 64×80=5120 / 障碍 range 16。
    expect(buffers.map(b => b.size)).toEqual([192, 32, 32, SOFT_BODY_GPU_PARAMS_BYTES, 16, 16, 16, 192, 5120, 16]);
    const obstaclePacked = new Float32Array(buffers[8]!.written!);
    // 跨核槽位在 pack 层已锁;此处锁 dispatch 写入的运行时数据:槽3=radius、槽19=判别式。
    expect([obstaclePacked[3], obstaclePacked[19]]).toEqual([Math.fround(0.8), Math.fround(0.8)]);
    expect(Array.from(new Uint32Array(buffers[9]!.written!))).toEqual([2, 0, 0, 0]);
    expect([result.dispatchCount, result.obstacleCount, result.edgeColors, result.volumeColors])
      .toEqual([softBodyParallelDispatchCount(2, 2, 1, 2), 2, 2, 1]);
    expect(buffers.every(b => b.destroyed)).toBe(true);
  });

  it("无障碍逐位退化:trace 与缓冲与既有编排逐位一致(零障碍 dispatch、零障碍缓冲)", async () => {
    const { device, buffers, trace } = fakeDevice();
    const result = await dispatchSoftBodyParallelGpuStep(device, { ...obstaclesInput, obstacles: undefined });
    const perSubstep = [
      "set:integrateParticles", "bind", "dispatch:1",
      "set:projectEdgesColor", "bind", "dispatch:1", "bind", "dispatch:1",
      "set:projectVolumesColor", "bind", "dispatch:1",
      "set:finalizeParticles", "bind", "dispatch:1",
    ];
    expect(trace).toEqual([...Array.from({ length: 2 }, () => perSubstep).flat(), "end", "copy"]);
    expect(buffers.map(b => b.size)).toEqual([192, 32, 32, SOFT_BODY_GPU_PARAMS_BYTES, 16, 16, 16, 192]);
    expect([result.dispatchCount, result.obstacleCount]).toEqual([10, 0]);
  });

  it("镜像无障碍逐位退化:obstacles 缺省 / 空数组 / 远离场景三种入参输出逐位一致", () => {
    const edgeColoring = colorClothConstraints(input.edges.map(e => e.a), input.edges.map(e => e.b), 4);
    const volumeColoring = colorSoftBodyVolumes(input.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), 4);
    const absent = mirrorSoftBodyParallelStep(input, edgeColoring, volumeColoring);
    const empty = mirrorSoftBodyParallelStep({ ...input, obstacles: [] }, edgeColoring, volumeColoring);
    const far = mirrorSoftBodyParallelStep({ ...input, obstacles: [
      { center: [1e6, 1e6, 1e6] as const, radius: 1, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, halfExtents: [0, 0, 0] as const },
    ] }, edgeColoring, volumeColoring);
    expect(Array.from(empty)).toEqual(Array.from(absent));
    expect(Array.from(far)).toEqual(Array.from(absent));
  });

  it("镜像障碍接触完整性:体素软体落在球障碍上,自由粒子全程不被穿透(60 tick)", () => {
    const positions: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];
    const physics = {
      particles: positions.map((position, index) => ({
        position: [position[0], position[1], position[2]] as [number, number, number],
        velocity: [0, 0, 0] as [number, number, number], inverseMass: index < 4 ? 0 : 1,
      })),
      edges: [
        { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }, { a: 0, b: 3, restLength: 1 },
        { a: 1, b: 4, restLength: 1 }, { a: 1, b: 5, restLength: 1 }, { a: 2, b: 4, restLength: 1 },
        { a: 2, b: 6, restLength: 1 }, { a: 3, b: 5, restLength: 1 }, { a: 3, b: 6, restLength: 1 },
        { a: 4, b: 7, restLength: 1 }, { a: 5, b: 7, restLength: 1 }, { a: 6, b: 7, restLength: 1 },
      ],
      tets: (() => {
        const raw = [[0, 1, 2, 3], [1, 4, 2, 3], [1, 5, 3, 4], [2, 3, 6, 4], [1, 2, 4, 6], [1, 3, 5, 6]];
        const at = (index: number) => positions[index]!;
        return raw.map(([i0, i1, i2, i3]) => {
          const a = at(i0), b = at(i1), c = at(i2), d = at(i3);
          const u = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
          const v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
          const w = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
          const det = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
          const indices = det > 0 ? [i0, i1, i2, i3] : [i0, i2, i1, i3];
          return { i0: indices[0]!, i1: indices[1]!, i2: indices[2]!, i3: indices[3]!, restVolume: Math.abs(det) / 6 };
        });
      })(),
      dtSeconds: 1 / 60, substeps: 8, complianceDistance: 0.001, complianceVolume: 0.001,
      damping: 0.01, gravity: [0, -9.81, 0] as const,
    };
    // p7 starts exactly on the sphere; the other free vertices are outside it.
    const sphere = { center: [1, 0.5, 1] as const, radius: 0.5,
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, halfExtents: [0, 0, 0] as const };
    const edgeColoring = colorClothConstraints(physics.edges.map(e => e.a), physics.edges.map(e => e.b), 8);
    const volumeColoring = colorSoftBodyVolumes(physics.tets.map(t => [t.i0, t.i1, t.i2, t.i3] as const), 8);
    let state = packSoftBodyGpuParticles(physics.particles);
    let particles = physics.particles.map(p => ({ ...p }));
    let minSurfaceGap = Number.POSITIVE_INFINITY;
    let maxPenetration = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      state = mirrorSoftBodyParallelStep({ ...physics, particles, obstacles: [sphere] }, edgeColoring, volumeColoring);
      particles = physics.particles.map((_, i) => ({
        position: [state[i * 12]!, state[i * 12 + 1]!, state[i * 12 + 2]!] as [number, number, number],
        velocity: [state[i * 12 + 4]!, state[i * 12 + 5]!, state[i * 12 + 6]!] as [number, number, number],
        inverseMass: state[i * 12 + 3]!,
      }));
      for (let i = 4; i < 8; i += 1) {
        const dist = Math.hypot(...particles[i]!.position.map((value, axis) => value - sphere.center[axis]!));
        minSurfaceGap = Math.min(minSurfaceGap, Math.abs(dist - sphere.radius));
        // 有界再穿透如实语义:每子步单次障碍投影在约束投影之前,边/体积约束会把粒子
        // 拉回球面内侧一小段(单子步约束修正量级);无发散穿透即接触稳定。
        maxPenetration = Math.max(maxPenetration, sphere.radius - dist);
      }
    }
    expect(maxPenetration).toBeLessThanOrEqual(0.06); // 约束回拉有界,无发散穿透
    // 接触可观测(CPU 侧):自由粒子确实贴上了球面(容差 0.05)。
    expect(minSurfaceGap).toBeLessThan(0.05);
    console.log(`[quant] CPU mirror 120 ticks: min surface gap=${minSurfaceGap.toExponential(3)}, max penetration=${maxPenetration.toExponential(3)}`);
  });
});
