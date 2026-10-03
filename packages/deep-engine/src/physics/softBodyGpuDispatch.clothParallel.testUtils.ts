// F6 并行核生产换核测试夹具(sourceSizeGate 拆分:自 softBodyGpuDispatch.clothParallel.test.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:WebGPU 枚举 shim、fake device(failMode 打击面)、网格/星形输入、期望命令流、
// A3 240 tick 指纹 parity fixture。
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { CLOTH_PARALLEL_ENTRY_INTEGRATE, DEEP_CLOTH_PARALLEL_SOLVER_WGSL } from "./clothSolverWgsl.js";

// Node 测试环境无 WebGPU 全局:垫最小枚举 shim(数值与规范一致,fake 只做位判断)。
export const GPU_ENUMS = {
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1, WRITE: 2 },
} as const;
for (const [key, value] of Object.entries(GPU_ENUMS)) (globalThis as Record<string, unknown>)[key] ??= value;

export type FailMode = "none" | "shader" | "pipeline";
// failMode 只打击并行核(真实回退场景 = 串行核可用、并行核特性缺失);串行核被打击时回退链整体失败,不入本测。

export interface FakeBuffer {
  size: number; usage: GPUBufferUsageFlags; written: ArrayBuffer | null; mapState: string; destroyed: boolean;
  mapAsync: () => Promise<void>; unmap: () => void; getMappedRange: () => ArrayBuffer; destroy: () => void;
}

export function fakeDevice(failMode: FailMode = "none"): { device: GPUDevice; buffers: FakeBuffer[]; trace: string[] } {
  const buffers: FakeBuffer[] = [];
  const trace: string[] = [];
  const device = {
    createBuffer: (descriptor: { size: number; usage: GPUBufferUsageFlags }) => {
      const buffer: FakeBuffer = {
        size: descriptor.size, usage: descriptor.usage, written: null, mapState: "unmapped", destroyed: false,
        mapAsync: async () => { buffer.mapState = "mapped"; }, unmap: () => { buffer.mapState = "unmapped"; },
        getMappedRange: () => new ArrayBuffer(descriptor.size), destroy: () => { buffer.destroyed = true; },
      };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
        expect(offset).toBe(0);
        // 裸 ArrayBuffer(pack 层约束/参数)与 TypedArray 视图(粒子)两种入参都取字节拷贝。
        buffer.written = data instanceof ArrayBuffer
          ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
      submit: () => { for (const b of buffers) if (b.usage & GPUBufferUsage.MAP_READ) b.mapState = "mapped"; },
    },
    createShaderModule: (descriptor: { code: string }) => {
      if (failMode === "shader" && descriptor.code === DEEP_CLOTH_PARALLEL_SOLVER_WGSL) {
        throw new Error("mock parallel shader module failure");
      }
      return { code: descriptor.code, getCompilationInfo: async () => ({ messages: [] }) };
    },
    createComputePipelineAsync: async (descriptor: { compute: { entryPoint: string } }) => {
      if (failMode === "pipeline" && descriptor.compute.entryPoint === CLOTH_PARALLEL_ENTRY_INTEGRATE) {
        throw new Error("mock parallel pipeline failure");
      }
      return { entryPoint: descriptor.compute.entryPoint, getBindGroupLayout: () => ({}) };
    },
    createBindGroup: (descriptor: { entries: unknown[] }) => ({ entryCount: descriptor.entries.length }),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: (pipeline: { entryPoint: string }) => { trace.push(`set:${pipeline.entryPoint}`); },
        setBindGroup: () => { trace.push("bind"); },
        dispatchWorkgroups: (count: number) => { trace.push(`dispatch:${count}`); },
        end: () => { trace.push("end"); },
      }),
      copyBufferToBuffer: () => { trace.push("copy"); },
      finish: () => ({ trace: [...trace] }),
    }),
  } as unknown as GPUDevice;
  return { device, buffers, trace };
}

/** 网格输入(构建序:右/下/两对角,与黄金/A3 拓扑同源)。 */
export function gridInput(columns: number, rows: number, substeps: number) {
  const spacing = 0.1;
  const particles = Array.from({ length: columns * rows }, (_, index) => ({
    position: [(index % columns) * spacing, Math.floor(index / columns) * spacing, 0] as const,
    velocity: [0, 0, 0] as const, inverseMass: index === 0 ? 0 : 1,
  }));
  const constraints: Array<{ a: number; b: number; restLength: number }> = [];
  const diagonal = spacing * Math.SQRT2;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const index = row * columns + col;
      if (col + 1 < columns) constraints.push({ a: index, b: index + 1, restLength: spacing });
      if (row + 1 < rows) constraints.push({ a: index, b: index + columns, restLength: spacing });
      if (col + 1 < columns && row + 1 < rows) {
        constraints.push({ a: index, b: index + columns + 1, restLength: diagonal },
          { a: index + 1, b: index + columns, restLength: diagonal });
      }
    }
  }
  return {
    particles, constraints,
    dtSeconds: 1 / 60, substeps, compliance: 0, damping: 0.01, gravity: [0, -9.81, 0] as const,
  };
}

/** N 约束共端点的星形拓扑:N>32 时着色必超 u32 掩码上限(fail-closed 的实触发)。 */
export function starInput(leaves: number) {
  return {
    particles: Array.from({ length: leaves + 1 }, (_, i) => ({
      position: [i * 0.1, 0, 0] as const, velocity: [0, 0, 0] as const, inverseMass: i === 0 ? 0 : 1 })),
    constraints: Array.from({ length: leaves }, (_, i) => ({ a: 0, b: i + 1, restLength: 0.1 })),
    dtSeconds: 1 / 60, substeps: 1, compliance: 0, damping: 0, gravity: [0, 0, 0] as const,
  };
}

export function expectedTrace(substeps: number, workgroups: number, colorWorkgroups: number[]): string[] {
  const perSubstep = [
    "set:integrateParticles", "bind", `dispatch:${workgroups}`,
    "set:projectConstraintsColor",
    ...colorWorkgroups.flatMap((count) => ["bind", `dispatch:${count}`]),
    "set:finalizeVelocityKinetics", "bind", `dispatch:${workgroups}`,
  ];
  return [...Array.from({ length: substeps }, () => perSubstep).flat(), "end", "copy"];
}

export const PARITY_FIXTURE = JSON.parse(readFileSync(new URL(
  "../../../deep-engine-native/tests/fixtures/cloth-parallel-compute-v1.json", import.meta.url), "utf8",
)) as { replay: { fingerprints: { per24: string[] } } };
