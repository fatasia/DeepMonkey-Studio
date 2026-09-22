import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { ProbeClipmapPbrTarget } from "./probeClipmapPbrController.js";
import { PbrRenderer } from "./pbrRenderer.js";

interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }

function fixture() {
  const buffers: FakeBuffer[] = [];
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const device = {
    limits: {}, queue: { writeBuffer: vi.fn(), submit: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => Promise.resolve()) }, lost,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createSampler: vi.fn(({ label }: { label: string }) => ({ label })),
    createTexture: vi.fn(({ label }: { label: string }) => ({ label, createView: vi.fn(() => ({ label })),
      destroy: vi.fn() })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage,
        destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(buffer); return buffer;
    }),
  };
  const session = { state: "ready", device } as unknown as DeviceSession;
  return { session, device: device as unknown as GPUDevice, buffers };
}

const target = (session: DeviceSession): ProbeClipmapPbrTarget => ({
  session,
  setProbeClipmap: () => {},
});

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PbrRenderer product probe-clipmap GI factory", () => {
  it("installs a real scene-radiance encoder so the product host reports radianceSource=scene", () => {
    const f = fixture();
    const renderer = Object.create(PbrRenderer.prototype) as PbrRenderer &
      { session: DeviceSession; probeRadianceProducer?: unknown };
    renderer.session = f.session;
    const controller = renderer.createProbeClipmapController(target(f.session), "studio-factory-test");
    expect(controller.radianceSource).toBe("scene");
    expect(controller.runtime.radianceSource).toBe("scene");
    // The producer is cached on the renderer so re-activation reuses the same capture chain.
    const second = renderer.createProbeClipmapController(target(f.session), "studio-factory-test-2");
    expect(second.radianceSource).toBe("scene");
    expect(renderer.probeRadianceProducer).toBeDefined();
    controller.dispose();
    second.dispose();
  });
});
