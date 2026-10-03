// Probe scene radiance producer 测试夹具(sourceSizeGate 拆分:自 probeSceneRadianceProducer.test.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:fake GPUDevice、地面 RenderPacket、probe update/capture 上下文构造、标准光照输入。
import { vi } from "vitest";
import type { ProbeCaptureBeginContext } from "../lighting/probeClipmapCaptureExecutor.js";
import type { ProbeClipmapPlan, ProbeUpdate } from "../lighting/probeClipmapPlan.js";
import type { RenderPacket } from "../renderPacket.js";
import type { ProbeRadianceLighting } from "./probeSceneRadianceProducer.js";

export interface FakeBuffer extends Omit<GPUBuffer, "destroy"> { readonly destroy: ReturnType<typeof vi.fn> }
interface PassRecord { readonly label: string; readonly dispatch: number[][] }

export function fixture() {
  const buffers: FakeBuffer[] = [];
  const encoders: PassRecord[][] = [];
  const writeBufferCalls: { buffer: unknown; offset: number; size: number | undefined }[] = [];
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const queue = { writeBuffer: vi.fn((buffer: GPUBuffer, offset: number, _data: BufferSource,
    size?: number) => { writeBufferCalls.push({ buffer, offset, size }); }),
    submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: {}, queue, lost,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label,
      getBindGroupLayout: vi.fn((index: number) => ({ label: `layout-${index}` })) })),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) =>
      ({ label, entries })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage,
        destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(buffer); return buffer;
    }),
    createCommandEncoder: vi.fn(() => {
      const passes: PassRecord[] = []; encoders.push(passes);
      return { beginComputePass: vi.fn(({ label }: { label: string }) => {
        const pass: PassRecord = { label, dispatch: [] }; passes.push(pass);
        return { setPipeline: vi.fn(), setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn((...args: number[]) => pass.dispatch.push(args)), end: vi.fn() };
      }) };
    }),
  };
  return { device: device as unknown as GPUDevice, rawDevice: device, queue, buffers,
    encoders, writeBufferCalls };
}

export function planePacket(baseColor: readonly [number, number, number] = [0.5, 0.5, 0.5],
  alphaMode?: "OPAQUE" | "BLEND"): RenderPacket {
  // Ground plane at y=0 with upward normals (position+normal interleaved, 6 floats/vertex).
  const corners: [number, number][] = [[-4, -4], [4, -4], [4, 4], [-4, 4]];
  const vertices = new Float32Array(corners.flatMap(([x, z]) => [x, 0, z, 0, 1, 0]));
  return { geometries: [{ id: "ground", revision: 0, vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
    materials: [{ id: "m", baseColor, metallic: 0, roughness: 1,
      ...(alphaMode ? { alphaMode } : {}) }],
    instances: [{ id: "ground-1", geometry: "ground", material: "m",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
}

export function update(index: number, position: readonly [number, number, number],
  localCell: readonly [number, number, number] = [0, 0, 0], level = 0): ProbeUpdate {
  return Object.freeze({ level, cell: localCell, localCell, linearIndex: index,
    position: Object.freeze([...position]) as unknown as ProbeUpdate["position"], reason: "initial" });
}

export function captureContext(device: GPUDevice, generation: number,
  updates: readonly ProbeUpdate[]) {
  const plan = { profile: { gridSize: [4, 2, 4] }, updates } as unknown as ProbeClipmapPlan;
  return {
    encoder: device.createCommandEncoder(),
    update: updates[0]!, updateIndex: 0,
    destination: {} as GPUTexture,
    destinationView: { label: "capture-view" } as unknown as GPUTextureView,
    destinationOrigin: Object.freeze({ x: 0, y: 0, z: 0 }),
    context: { generation, plan, deviceEpoch: "e", signal: new AbortController().signal,
      resource: {} } as unknown as ProbeCaptureBeginContext,
  };
}

export const sunlit: ProbeRadianceLighting = {
  primary: { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 2 },
  ambient: [0.1, 0.1, 0.1] };
