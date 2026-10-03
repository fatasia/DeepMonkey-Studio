// F6/T18 风场刀:软体并行核风 CPU 合同(pack 风槽/镜像风公式/零风逐位退化/风×障碍组合/
// dispatch per-substep 副本)。噪声单一真源 = clothParallelSolver.mirrorWindNoise
// (与 WGSL windValueNoise 逐位同构,布料侧已锁 0/200000 mismatch;本文件只锁软体接线:
// 盐、y 坐标、tick 基、子步递进、槽序)。
import { describe, expect, it } from "vitest";
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "./softBodyVolumeColoring.js";
import { mirrorWindNoise } from "./clothParallelSolver.js";
import { dispatchSoftBodyParallelGpuStep } from "./softBodyGpuDispatch.softbodyParallel.js";
import { mirrorSoftBodyParallelStep } from "./softBodyParallelMirror.js";
import {
  packSoftBodyGpuParticles, packSoftBodyGpuParams, SOFT_BODY_GPU_PARAMS_BYTES,
  type SoftBodyGpuParticleInput, type SoftBodyGpuStepInput,
} from "./softBodyGpuWgsl.js";

const WIND = {
  direction: [0.6, 0, 0.2] as const, baseSpeed: 1.2, gustFrequency: 0.9,
  spatialScale: 2.5, seed: 7, tickSeconds: 0,
};

// 体素软体夹具(与障碍刀同源:锚定 0..3,自由 4..7;构造期 tet 环绕规整为正体积——
// 负 signedVolume≠正 restVolume 教训)。
const VOXEL_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
function voxelPhysics(): SoftBodyGpuStepInput {
  return {
    particles: VOXEL_POSITIONS.map((position, index): SoftBodyGpuParticleInput => ({
      position: [position[0], position[1], position[2]], velocity: [0, 0, 0], inverseMass: index < 4 ? 0 : 1,
    })),
    edges: [
      { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }, { a: 0, b: 3, restLength: 1 },
      { a: 1, b: 4, restLength: 1 }, { a: 1, b: 5, restLength: 1 }, { a: 2, b: 4, restLength: 1 },
      { a: 2, b: 6, restLength: 1 }, { a: 3, b: 5, restLength: 1 }, { a: 3, b: 6, restLength: 1 },
      { a: 4, b: 7, restLength: 1 }, { a: 5, b: 7, restLength: 1 }, { a: 6, b: 7, restLength: 1 },
    ],
    tets: (() => {
      const raw = [[0, 1, 2, 3], [1, 4, 2, 3], [1, 5, 3, 4], [2, 3, 6, 4], [1, 2, 4, 6], [1, 3, 5, 6]];
      const at = (index: number) => VOXEL_POSITIONS[index]!;
      return raw.map(([i0, i1, i2, i3]) => {
        const a = at(i0), b = at(i1), c = at(i2), d = at(i3);
        const u = [b[0] - d[0], b[1] - d[1], b[2] - d[2]];
        const v = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
        const w = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
        const det = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
        const indices = det > 0 ? [i0, i1, i2, i3] : [i0, i2, i1, i3];
        return { i0: indices[0]!, i1: indices[1]!, i2: indices[2]!, i3: indices[3]!, restVolume: Math.abs(det) / 6 };
      });
    })(),
    dtSeconds: 1 / 60, substeps: 8, complianceDistance: 0.001, complianceVolume: 0.001,
    damping: 0.01, gravity: [0, -9.81, 0],
  };
}
const EDGE_COLORING = colorClothConstraints(
  Array.from({ length: 12 }, (_, i) => [0, 1, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6][i]!),
  Array.from({ length: 12 }, (_, i) => [1, 2, 3, 4, 5, 4, 6, 5, 6, 7, 7, 7][i]!), 8);
const VOLUME_COLORING = colorSoftBodyVolumes(
  [[0, 1, 2, 3], [1, 4, 2, 3], [1, 5, 3, 4], [2, 3, 6, 4], [1, 2, 4, 6], [1, 3, 5, 6]] as const, 8);

const fromState = (state: Float32Array): SoftBodyGpuParticleInput[] =>
  VOXEL_POSITIONS.map((_, i) => ({
    position: [state[i * 12]!, state[i * 12 + 1]!, state[i * 12 + 2]!],
    velocity: [state[i * 12 + 4]!, state[i * 12 + 5]!, state[i * 12 + 6]!],
    inverseMass: state[i * 12 + 3]!,
  }));
const fingerprint = (state: Float32Array): string => {
  let h = 0x811c9dc1;
  for (const byte of new Uint8Array(state.buffer, state.byteOffset, state.byteLength)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16);
};
const stepMirror = (input: SoftBodyGpuStepInput, times: number): Float32Array => {
  let state = packSoftBodyGpuParticles(input.particles);
  let particles = input.particles.map(p => ({ ...p }));
  for (let tick = 0; tick < times; tick += 1) {
    state = mirrorSoftBodyParallelStep({ ...input, particles }, EDGE_COLORING, VOLUME_COLORING);
    particles = fromState(state);
  }
  return state;
};

describe("F6/T18 软体并行核风场:镜像合同(CPU)", () => {
  it("零风逐位退化:wind 缺省 / wind:undefined / 远离场景的风对象缺席路径输出逐位一致", () => {
    const physics = voxelPhysics();
    const absent = stepMirror(physics, 30);
    const undefinedWind = stepMirror({ ...physics, wind: undefined }, 30);
    expect(Array.from(undefinedWind)).toEqual(Array.from(absent));
  });

  it("风生效:同夹具风开/风关 120 tick 终态指纹不同;自由粒子位移在风方向投影为正", () => {
    const physics = voxelPhysics();
    const calm = stepMirror(physics, 120);
    const windy = stepMirror({ ...physics, wind: WIND }, 120);
    expect(fingerprint(windy)).not.toBe(fingerprint(calm));
    const dot = [0, 1, 2].map(axis => (windy[(4 + 3) * 12 + axis]! - calm[(4 + 3) * 12 + axis]!) * WIND.direction[axis]!)
      .reduce((a, b) => a + b, 0);
    expect(dot).toBeGreaterThan(0);
  });

  it("风公式单步解析对拍:1 子步无重力无阻尼,速度=direction·baseSpeed·(0.5+noise(tick·gust,y·scale,seed^salt))·h", () => {
    const base: SoftBodyGpuStepInput = {
      particles: [0, 1, 2, 3].map(index => ({
        position: [index * 0.5, 0.25, 0] as [number, number, number],
        velocity: [0, 0, 0] as [number, number, number], inverseMass: 1,
      })),
      edges: [], tets: [], dtSeconds: 1 / 60, substeps: 1,
      complianceDistance: 0, complianceVolume: 0, damping: 0, gravity: [0, 0, 0],
    };
    const salt = 0x51ed2701;
    for (const tickBase of [0, 1 / 60, 2.5]) {
      const state = mirrorSoftBodyParallelStep({ ...base, wind: { ...WIND, tickSeconds: tickBase } },
        colorClothConstraints([], [], 4), colorSoftBodyVolumes([], 4));
      const noise = mirrorWindNoise(tickBase * WIND.gustFrequency, 0.25 * WIND.spatialScale, (WIND.seed ^ salt) >>> 0);
      const speed = WIND.baseSpeed * (0.5 + noise);
      // 速度=加速度·h(fround 至 f32);finalize 回算 Δpos/h 会放大位置舍入(位置 ~1 的
      // ULP×1/h ≈ 1e-5)——容差按舍入放大域设 1e-5,仍足以拒绝错盐/错 y/错 tick 基/
      // 错方向映射(均为 order-1 差)。
      const expected = [0, 1, 2].map(axis => Math.fround(Math.fround(WIND.direction[axis]! * speed) * (1 / 60)));
      for (let particle = 0; particle < 4; particle += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          expect(Math.abs(state[particle * 12 + 4 + axis]! - expected[axis]!)).toBeLessThanOrEqual(1e-5);
        }
      }
    }
  });

  it("风×障碍组合:球置于风下游,体素软体被风压在球面(接触由风维持),组合与纯风/纯障碍互相不同", () => {
    const physics = voxelPhysics();
    // p7=(1,1,1) 起始于球(-x 面)上;风向 +x 把体压向球心,重力沿面下滑——
    // 风法向压持+重力切向滑动真组合。判据:全程接触可观测(组合),且纯重力对照
    // 最终离开球面(风是维持接触的原因,非初始贴面的平凡真)。
    const sphere = { center: [1.5, 1, 1] as const, radius: 0.5, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, halfExtents: [0, 0, 0] as const };
    const gapOf = (state: Float32Array, index: number): number => Math.abs(Math.hypot(
      state[index * 12]! - sphere.center[0], state[index * 12 + 1]! - sphere.center[1], state[index * 12 + 2]! - sphere.center[2]) - sphere.radius);
    const run = (wind: typeof WIND | undefined, withObstacle: boolean): { minGap: number; finalGap: number; fingerprint: string } => {
      let state = packSoftBodyGpuParticles(physics.particles);
      let particles = physics.particles.map(p => ({ ...p }));
      let minGap = Number.POSITIVE_INFINITY;
      for (let tick = 0; tick < 120; tick += 1) {
        state = mirrorSoftBodyParallelStep({
          ...physics, particles, wind, ...(withObstacle ? { obstacles: [sphere] } : {}),
        }, EDGE_COLORING, VOLUME_COLORING);
        particles = fromState(state);
        if (withObstacle) for (let i = 4; i < 8; i += 1) minGap = Math.min(minGap, gapOf(state, i));
      }
      return { minGap, finalGap: Math.min(...[4, 5, 6, 7].map(i => gapOf(state, i))), fingerprint: fingerprint(state) };
    };
    const combo = run(WIND, true);
    const onlyWind = run(WIND, false);
    const gravityOnly = run(undefined, true);
    expect(combo.fingerprint).not.toBe(onlyWind.fingerprint);
    expect(combo.fingerprint).not.toBe(gravityOnly.fingerprint);
    // 全程接触可观测:组合场景自由粒子全程不被推离球面(风+重力共同压持)。
    expect(combo.minGap).toBeLessThan(0.05);
    expect(combo.finalGap).toBeLessThan(0.1);
    // 负控:无风时纯重力沿 -y 下滑离开球面,终态间隙显著大于组合场景——
    // 接触的维持者是风,不是初始贴面的平凡残留。
    expect(gravityOnly.finalGap).toBeGreaterThan(combo.finalGap + 0.05);
    console.log(`[quant] wind×obstacle mirror 120 ticks: combo min=${combo.minGap.toExponential(3)} final=${combo.finalGap.toFixed(4)}; ` +
      `gravity-only final=${gravityOnly.finalGap.toFixed(4)}`);
  });
});

// —— dispatch 编排(fake device):per-substep params 副本 + 零风单副本逐位退化 ——

const GPU_ENUMS = {
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1, WRITE: 2 },
} as const;
for (const [key, value] of Object.entries(GPU_ENUMS)) (globalThis as Record<string, unknown>)[key] ??= value;

function fakeDevice() {
  const buffers: Array<{ size: number; usage: number; written: ArrayBuffer | null; destroyed: boolean }> = [];
  const trace: string[] = [];
  const device = {
    createBuffer: (descriptor: { size: number; usage: number }) => {
      const buffer = {
        size: descriptor.size, usage: descriptor.usage, written: null as ArrayBuffer | null, destroyed: false,
        mapAsync: async () => {}, unmap: () => {}, getMappedRange: () => new ArrayBuffer(descriptor.size), destroy: () => { buffer.destroyed = true; },
      };
      buffers.push(buffer); return buffer;
    },
    queue: {
      writeBuffer: (buffer: { written: ArrayBuffer | null }, offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
        buffer.written = data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
      submit: () => { for (const b of buffers) if (b.usage & GPUBufferUsage.MAP_READ) (b as unknown as { mapState?: string }).mapState = "mapped"; },
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async (descriptor: { compute: { entryPoint: string } }) => ({ entryPoint: descriptor.compute.entryPoint, getBindGroupLayout: () => ({}) }),
    createBindGroup: (descriptor: { entries: Array<{ binding: number; resource: { buffer: unknown } }> }) =>
      ({ bindings: descriptor.entries.map(e => e.binding), buffers: descriptor.entries.map(e => e.resource.buffer) }),
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

describe("F6/T18 软体并行核风场:dispatch 编排(fake device)", () => {
  it("风开编排:每子步一个 params uniform 副本(槽 17 = fround(tick 基+sub·h) 逐位),integrate bind group 逐子步换绑", async () => {
    const { device, buffers } = fakeDevice();
    const physics = { ...voxelPhysics(), substeps: 3 };
    await dispatchSoftBodyParallelGpuStep(device, { ...physics, wind: WIND });
    // 缓冲序:state 192 / edge / tet / params×3 / ranges / readback;params 均 96B。
    const paramsBuffers = buffers.filter(b => b.usage & GPUBufferUsage.UNIFORM && b.size === SOFT_BODY_GPU_PARAMS_BYTES);
    expect(paramsBuffers.length).toBe(3);
    const h = physics.dtSeconds / physics.substeps;
    paramsBuffers.forEach((buffer, sub) => {
      const floats = new Float32Array(buffer.written!);
      expect(floats[17]).toBe(Math.fround(WIND.tickSeconds + sub * h));
      const integers = new Uint32Array(buffer.written!);
      expect(integers[12]).toBe(1); // windEnabled
      expect(integers[13]).toBe((WIND.seed ^ 0x51ed2701) >>> 0);
    });
    expect(buffers.every(b => b.destroyed)).toBe(true);
  });

  it("风关逐位退化:params 单副本(96B,尾 48B 零),trace 与既有编排形状逐位一致", async () => {
    const noWind = fakeDevice();
    await dispatchSoftBodyParallelGpuStep(noWind.device, { ...voxelPhysics(), substeps: 2 });
    const paramsBuffers = noWind.buffers.filter(b => b.size === SOFT_BODY_GPU_PARAMS_BYTES);
    expect(paramsBuffers.length).toBe(1);
    expect(Array.from(new Uint32Array(paramsBuffers[0]!.written!, 48))).toEqual(new Array<number>(12).fill(0));
    expect(noWind.trace.filter(entry => entry === "set:integrateParticles").length).toBe(2);
    // 风开时 substeps 个 integrate bind group 换绑不改变 dispatch/trace 形状。
    const withWind = fakeDevice();
    await dispatchSoftBodyParallelGpuStep(withWind.device, { ...voxelPhysics(), substeps: 2, wind: WIND });
    expect(withWind.trace).toEqual(noWind.trace);
  });

  it("非法风输入 fail-closed(pack 层单一校验源):非有限字段拒收", async () => {
    const { device } = fakeDevice();
    await expect(dispatchSoftBodyParallelGpuStep(device, {
      ...voxelPhysics(), wind: { ...WIND, baseSpeed: Number.NaN },
    })).rejects.toThrow(/baseSpeed/);
  });
});
