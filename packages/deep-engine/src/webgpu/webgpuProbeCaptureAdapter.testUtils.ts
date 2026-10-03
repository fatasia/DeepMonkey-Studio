// WebGPU probe capture adapter 测试夹具(sourceSizeGate 拆分:自 webgpuProbeCaptureAdapter.test.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:fake GPUDevice/DeviceSession、clipmap 计划与 begin 上下文构造、事务执行辅助。
import { vi } from "vitest";
import type { ProbeCaptureBeginContext, ProbeCaptureTransaction } from "../lighting/probeClipmapCaptureExecutor.js";
import { planIrradianceProbeClipmap, type ProbeClipmapPlan } from "../lighting/probeClipmapPlan.js";
import type { ProbeClipmapGpuResource } from "../lighting/probeClipmapResources.js";
import type { DeviceSession } from "./deviceSession.js";
import { WebGpuProbeCaptureAdapter } from "./webgpuProbeCaptureAdapter.js";
import type { WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding } from "./webgpuProbeCaptureTypes.js";

export interface FakeTexture extends GPUTexture {
  readonly descriptor: GPUTextureDescriptor;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}
export interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }
interface PassRecord { readonly label: string; readonly dispatch: number[][] }
interface EncoderRecord { readonly passes: PassRecord[]; readonly copies: unknown[][] }

export function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>(), textures: FakeTexture[] = [], buffers: FakeBuffer[] = [];
  const encoders: EncoderRecord[] = [];
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const queue = { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = {
    limits: { maxTextureDimension2D: 16_384, maxTextureArrayLayers: 256,
      maxComputeWorkgroupsPerDimension: 65_535 }, queue, lost,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ descriptor })),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict;
      const texture = { width: size.width, height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers, mipLevelCount: descriptor.mipLevelCount ?? 1,
        sampleCount: 1, dimension: "2d", format: descriptor.format, usage: descriptor.usage, descriptor,
        destroy: vi.fn(), createView: vi.fn((view = {}) => ({ texture, view })) } as unknown as FakeTexture;
      textures.push(texture); return texture;
    }),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage,
        destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(buffer); return buffer;
    }),
    createCommandEncoder: vi.fn(() => {
      const record: EncoderRecord = { passes: [], copies: [] }; encoders.push(record);
      return {
        copyTextureToTexture: vi.fn((...args: unknown[]) => record.copies.push(args)),
        beginComputePass: vi.fn(({ label }: { label: string }) => {
          const pass: PassRecord = { label, dispatch: [] }; record.passes.push(pass);
          return { setPipeline: vi.fn(), setBindGroup: vi.fn(),
            dispatchWorkgroups: vi.fn((...args: number[]) => pass.dispatch.push(args)), end: vi.fn() };
        }),
        finish: vi.fn(() => ({ id: encoders.length })),
      };
    }),
  };
  const session = { state: "ready", device,
    own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); },
  };
  return { session: session as unknown as DeviceSession, rawSession: session, device, queue,
    owned, textures, buffers, encoders };
}

export function plan(previous?: ProbeClipmapPlan): ProbeClipmapPlan {
  return planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0],
    sceneBounds: { min: [-100, -100, -100], max: [100, 100, 100] },
    ...(previous ? { previous: previous.history } : {}),
    options: { levelCount: 2, gridSize: [4, 2, 4], updateBudget: 4 } });
}
export function context(source: ProbeClipmapPlan, invalidation: "initial" | "none" | "resize" = "initial",
  dynamicUpdateIndices: readonly number[] = []):
ProbeCaptureBeginContext {
  const buffer = {} as GPUBuffer;
  return { generation: 1, deviceEpoch: "gpu-1", plan: source, signal: new AbortController().signal,
    resource: { deviceEpoch: "gpu-1", profileKey: "probe-profile", plan: source,
      probeStorageBuffer: buffer, updateListBuffer: buffer, levelMetadataBuffer: buffer,
      allocatedBytes: source.profile.estimatedBytes } as ProbeClipmapGpuResource,
    publication: { frame: 0, schedulerGeneration: 1, frameBudget: 4,
      capacityBudget: 4, cameraCut: false, invalidation, dynamicUpdateIndices } };
}
export async function execute(transaction: ProbeCaptureTransaction<WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding>,
  adapter: WebGpuProbeCaptureAdapter, source: ProbeClipmapPlan): Promise<WebGpuProbeSamplingBinding> {
  source.updates.forEach((update, index) => transaction.encodeCapture(update, index));
  source.updates.forEach((update, index) => transaction.encodeFilter(update, index));
  source.updates.forEach((update, index) => transaction.encodeMips(update, index));
  const submission = transaction.finish(); await adapter.submit(submission, new AbortController().signal);
  return transaction.commit();
}
