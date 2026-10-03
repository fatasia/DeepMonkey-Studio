import { describe, expect, it } from "vitest";
import { mirrorClothGpuStep } from "./clothGpuWgsl.js";
import { mirrorSoftBodyGpuStep } from "./softBodyGpuWgsl.js";
import { dispatchClothGpuStep, dispatchSoftBodyGpuStep } from "./softBodyGpuDispatch.js";

/**
 * F6 GPU dispatch 生产入口的编排测试(无适配器环境):
 * 以最小 fake GPUDevice 验证 pack→缓冲→单工作组 dispatch→readback 的调用序、
 * 缓冲尺寸与映射语义。真实 GPU 执行(Naga 校验/数值)是另一证据维度,见
 * clothSoftBodyGpuWgsl.test.ts 的 DEEP_SHADER_NAGA_BIN 门与 lab 探针。
 */

interface RecordedBuffer {
  size: number;
  usage: GPUBufferUsageFlags;
  written: number;
  mapped: boolean;
  mapState: string;
  destroyed: boolean;
}

// Node 测试环境无 WebGPU 全局:垫最小枚举 shim(数值与规范一致即可,fake 只做位判断)。
const GPU_ENUMS = {
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1, WRITE: 2 },
} as const;
for (const [key, value] of Object.entries(GPU_ENUMS)) {
  (globalThis as Record<string, unknown>)[key] ??= value;
}

function fakeDevice(stateBytes: number) {
  const buffers: RecordedBuffer[] = [];
  const submissions: Array<{ copyLength: number }> = [];
  const device = {
    createBuffer: (descriptor: { size: number; usage: GPUBufferUsageFlags }) => {
      const buffer: RecordedBuffer = {
        size: descriptor.size, usage: descriptor.usage, written: 0,
        mapped: false, mapState: "unmapped", destroyed: false,
      };
      const withMethods = buffer as unknown as RecordedBuffer & {
        unmap: () => void;
        getMappedRange: () => ArrayBuffer;
        destroy: () => void;
      };
      withMethods.unmap = () => { buffer.mapState = "unmapped"; };
      withMethods.getMappedRange = () => new ArrayBuffer(descriptor.size);
      withMethods.destroy = () => { buffer.destroyed = true; };
      withMethods.mapAsync = async () => {
        buffer.mapState = "mapped";
        buffer.mapped = true;
      };
      buffers.push(buffer);
      return withMethods;
    },
    queue: {
      writeBuffer: (buffer: RecordedBuffer, offset: number, data: ArrayBufferView) => {
        expect(offset).toBe(0);
        buffer.written = data.byteLength;
      },
      submit: () => {
        // submit 时把状态缓冲视为已写出,readback 可映射。
        const stateBuffer = buffers.find(candidate => candidate.usage & GPUBufferUsage.COPY_SRC);
        const readbackBuffer = buffers[buffers.length - 1]!;
        submissions.push({ copyLength: readbackBuffer.size });
        void stateBuffer;
        readbackBuffer.mapState = "mapped";
        readbackBuffer.mapped = true;
      },
    },
    createShaderModule: (descriptor: { code: string }) => ({ code: descriptor.code }),
    createComputePipelineAsync: async (descriptor: { compute: { entryPoint: string } }) => ({
      entryPoint: descriptor.compute.entryPoint,
      getBindGroupLayout: () => ({}),
    }),
    createBindGroup: (descriptor: { entries: unknown[] }) => ({ entryCount: descriptor.entries.length }),
    createCommandEncoder: () => {
      const commands: string[] = [];
      return {
        beginComputePass: () => ({
          setPipeline: () => commands.push("pipeline"),
          setBindGroup: () => commands.push("bindgroup"),
          dispatchWorkgroups: (count: number) => {
            expect(count).toBe(1);
            commands.push(`dispatch${count}`);
          },
          end: () => commands.push("end"),
        }),
        copyBufferToBuffer: (_source: unknown, sourceOffset: number, target: RecordedBuffer, targetOffset: number, size: number) => {
          expect(sourceOffset).toBe(0);
          expect(targetOffset).toBe(0);
          expect(size).toBe(stateBytes);
          commands.push("copy");
          void target;
        },
        finish: () => {
          expect(commands).toEqual(["pipeline", "bindgroup", "dispatch1", "end", "copy"]);
          return { commands };
        },
      };
    },
  } as unknown as GPUDevice;
  return { device, buffers, submissions };
}

const clothInput = {
  particles: [
    { position: [0, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 0 },
    { position: [1.15, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
  ],
  constraints: [{ a: 0, b: 1, restLength: 1 }],
  dtSeconds: 1 / 60, substeps: 2, compliance: 0, damping: 0, gravity: [0, 0, 0] as const,
};

const softInput = {
  particles: [
    { position: [0, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 0 },
    { position: [1, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
    { position: [0, 1, 0] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
    { position: [0, 0, 1] as const, velocity: [0, 0, 0] as const, inverseMass: 1 },
  ],
  edges: [
    { a: 0, b: 1, restLength: 1 }, { a: 0, b: 2, restLength: 1 }, { a: 0, b: 3, restLength: 1 },
    { a: 1, b: 2, restLength: Math.SQRT2 }, { a: 1, b: 3, restLength: Math.SQRT2 },
    { a: 2, b: 3, restLength: Math.SQRT2 },
  ],
  tets: [{ i0: 0, i1: 2, i2: 1, i3: 3, restVolume: 1 / 6 }],
  dtSeconds: 1 / 60, substeps: 2, complianceDistance: 0, complianceVolume: 0,
  damping: 0, gravity: [0, 0, 0] as const,
};

describe("F6 GPU dispatch 生产入口(编排语义)", () => {
  it("cloth dispatch:状态缓冲 12 floats/粒子,readback 与镜像布局一致", async () => {
    const stateBytes = 2 * 48;
    const { device, buffers } = fakeDevice(stateBytes);
    const result = await dispatchClothGpuStep(device, clothInput);
    expect(result.state.byteLength).toBe(stateBytes);
    // uniform 48B + 粒子 96B + 约束 16B + readback 96B。
    expect(buffers.map(buffer => buffer.size)).toEqual([48, 96, 16, 96]);
    // 粒子缓冲带初值写入,readback 映射后已释放 unmap 前态由 finally 收口。
    const layout = mirrorClothGpuStep(clothInput);
    expect(result.state.byteLength).toBe(layout.byteLength);
  });

  it("soft-body dispatch:tet/edge 缓冲按 ABI 字节对齐", async () => {
    const stateBytes = 4 * 48;
    const { device, buffers } = fakeDevice(stateBytes);
    const result = await dispatchSoftBodyGpuStep(device, softInput);
    expect(result.state.byteLength).toBe(stateBytes);
    // uniform 96B(风场刀 96B ABI;串行核按头 48B 消费)+ 粒子 192B + 边 6×16B +
    // 四面体 32B + readback 192B。
    expect(buffers.map(buffer => buffer.size)).toEqual([96, 192, 96, 32, 192]);
    const layout = mirrorSoftBodyGpuStep(softInput);
    expect(result.state.byteLength).toBe(layout.byteLength);
  });

  it("非法输入沿用 pack 层校验 fail-closed(dispatch 不另立门)", async () => {
    const { device } = fakeDevice(2 * 48);
    await expect(dispatchClothGpuStep(device, {
      ...clothInput, particles: clothInput.particles.slice(0, 1),
    })).rejects.toThrow(/outside/);
    await expect(dispatchSoftBodyGpuStep(device, {
      ...softInput, damping: 1,
    })).rejects.toThrow(/\[0,1\)/);
  });
});
