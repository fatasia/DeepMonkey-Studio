import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrParticlePass } from "./pbrParticlePass.js";
import type { GpuParticleRenderBinding } from "./gpuParticleRuntime.js";

interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }

function fixture() {
  const buffers: FakeBuffer[] = [];
  const passes: Array<{ label: string; draws: unknown[][] }> = [];
  const writeBufferCalls: Array<{ buffer: unknown; data: Float32Array }> = [];
  const lost = new Promise<GPUDeviceLostInfo>(() => {});
  const device = {
    limits: {}, lost,
    queue: { writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: BufferSource) => {
      writeBufferCalls.push({ buffer, data: new Float32Array(data as ArrayBuffer) }); }),
      submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(null)),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => ({ descriptor,
      getBindGroupLayout: vi.fn((index: number) => ({ label: `layout-${index}` })) })),
    createBindGroup: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage,
        destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(buffer); return buffer;
    }),
  };
  const session = { state: "ready", device } as unknown as DeviceSession;
  return { session, rawDevice: device, device: device as unknown as GPUDevice, buffers,
    passes, writeBufferCalls,
    encoder: (): GPUCommandEncoder => ({
      beginRenderPass: ({ label }: { label: string }) => {
        const record = { label, draws: [] as unknown[][] }; passes.push(record);
        return { setPipeline: vi.fn(), setBindGroup: vi.fn(),
          drawIndirect: vi.fn((...args: unknown[]) => record.draws.push(args)), end: vi.fn() };
      },
    }) as unknown as GPUCommandEncoder,
  };
}

const camera = { viewProjection: Array.from({ length: 16 }, (_, index) => index / 16),
  cameraRight: [1, 0, 0] as [number, number, number], cameraUp: [0, 1, 0] as [number, number, number] };
const binding = { bindGroupIndex: 0, bindGroup: {}, stateBuffer: {} as GPUBuffer,
  indirectBuffer: {} as GPUBuffer, capacity: 1024, stride: 64 } as unknown as GpuParticleRenderBinding;

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, COMPUTE: 2, FRAGMENT: 4 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PBR particle render pass", () => {
  it("creates a premultiplied-alpha pipeline with depth test on and depth write off", () => {
    const f = fixture();
    new PbrParticlePass(f.session, "rgba16float", "depth24plus");
    const descriptor = (f.rawDevice.createRenderPipeline as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as GPURenderPipelineDescriptor;
    expect(descriptor.fragment!.targets![0]!.format).toBe("rgba16float");
    expect(descriptor.fragment!.targets![0]!.blend).toMatchObject({
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } });
    expect(descriptor.depthStencil).toMatchObject({ format: "depth24plus",
      depthWriteEnabled: false, depthCompare: "less-equal" });
    expect(descriptor.primitive).toMatchObject({ topology: "triangle-list", cullMode: "none" });
  });

  it("encodes one indirect draw with the camera uniform and the simulation buffers", () => {
    const f = fixture();
    const pass = new PbrParticlePass(f.session, "rgba16float", "depth24plus");
    pass.encode({ encoder: f.encoder(), colorView: {} as GPUTextureView,
      depthView: {} as GPUTextureView, width: 1920, height: 1080, camera, binding });
    expect(f.passes).toHaveLength(1);
    expect(f.passes[0]!.label).toMatch(/particles/);
    // drawIndirect(buffer, offset) - instance count stays on the GPU.
    expect(f.passes[0]!.draws[0]).toEqual([binding.indirectBuffer, 0]);
    const written = f.writeBufferCalls[0]!.data;
    expect(written.length).toBe(24);
    expect(written[16]).toBe(1); expect(written[17]).toBe(0); expect(written[18]).toBe(0);
    expect(written[20]).toBe(0); expect(written[21]).toBe(1); expect(written[22]).toBe(0);
  });

  it("rejects a non-positive extent and refuses to encode after disposal", () => {
    const f = fixture();
    const pass = new PbrParticlePass(f.session, "rgba16float", "depth24plus");
    const encode = (width: number, height: number) => pass.encode({ encoder: f.encoder(),
      colorView: {} as GPUTextureView, depthView: {} as GPUTextureView, width, height, camera, binding });
    expect(() => encode(0, 1080)).toThrow(RangeError);
    expect(() => encode(1920, -1)).toThrow(RangeError);
    pass.dispose(); pass.dispose();
    expect(() => encode(1920, 1080)).toThrow(/disposed/);
    expect(f.buffers.every(buffer => (buffer.destroy as ReturnType<typeof vi.fn>).mock.calls.length === 1))
      .toBe(true);
  });

  it("fails closed when the session is not ready", () => {
    const f = fixture();
    const notReady = { state: "lost", device: f.device } as unknown as DeviceSession;
    expect(() => new PbrParticlePass(notReady, "rgba16float", "depth24plus")).toThrow(/not ready/);
  });
});
