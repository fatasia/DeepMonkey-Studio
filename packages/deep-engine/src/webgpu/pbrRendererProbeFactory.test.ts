import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import { ProbeSceneRadianceProducer } from "../rayTracing/probeSceneRadianceProducer.js";
import type { DeviceSession } from "./deviceSession.js";
import type { WebGpuProbeRadianceContext } from "./webgpuProbeCaptureTypes.js";
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
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label,
      getBindGroupLayout: vi.fn(() => ({})) })),
    createBindGroup: vi.fn(({ label }: { label: string }) => ({ label })),
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
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 });
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
    expect(controller.runtime.current).toBeUndefined();
    expect(f.buffers.some(buffer => buffer.size === 576)).toBe(true); // production 32-direction uniform
    const producer = renderer.probeRadianceProducer as ProbeSceneRadianceProducer;
    const packet: RenderPacket = { geometries: [{ id: "ground", revision: 0,
      vertices: new Float32Array([-1, 0, -1, 0, 1, 0, 1, 0, -1, 0, 1, 0,
        0, 0, 1, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "ground", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [{ id: "ground", geometry: "ground", material: "ground",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
    producer.syncScene(packet);
    producer.syncLighting({ ambient: [0.1, 0.1, 0.1] });
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const context = { context: { generation: 1, plan: { profile: { gridSize: [2, 2, 2] },
      updates: [{ level: 0, localCell: [0, 0, 0], position: [0, 1, 0] }] } },
    destinationView: {} as GPUTextureView,
    encoder: { beginComputePass: vi.fn(() => pass) } } as unknown as WebGpuProbeRadianceContext;
    producer.encodeSourceRadiance(context);
    expect(producer.lastBatchStats).toMatchObject({ directionCount: 32, updates: 1 });
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1);
    const uniformWrite = (f.session.device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls
      .find(([, , data]) => data instanceof ArrayBuffer && data.byteLength === 576);
    expect(uniformWrite).toBeDefined();
    expect(new Uint32Array(uniformWrite![2] as ArrayBuffer)[1]).toBe(32);
    controller.dispose();
    second.dispose();
  });
});
