import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import { describePbrPresentPasses, PbrOutputBindings } from "./pbrOutputBindings.js";
import { DEFAULT_EXTENDED_HEADROOM, HDR_REFERENCE_WHITE_NITS, resolveHdrDisplayPolicy, type HdrDisplayPolicy } from "./hdrDisplayOutput.js";

function hdrFixture() {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 2 });
  const owned = new Set<unknown>();
  const hdrPipeline = { __kind: "hdr-pipeline" };
  const device = { limits: { maxTextureDimension2D: 8192 },
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createBindGroupLayout: vi.fn(() => ({ __kind: "bgl" })),
    createPipelineLayout: vi.fn(() => ({ __kind: "layout" })),
    createRenderPipelineAsync: vi.fn(async () => hdrPipeline),
    createTexture: vi.fn(() => ({ width: 32, height: 16, createView: () => ({}), destroy: vi.fn() })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })), createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({ __kind: "bind-group" })), queue: { writeBuffer: vi.fn() } };
  const surface = {} as GPUTextureView;
  const context = { getCurrentTexture: vi.fn(() => ({ createView: () => surface })) };
  const session = { device, context, state: "ready", format: "bgra8unorm",
    own: (value: unknown) => { owned.add(value); return value; },
    release: vi.fn((value: unknown) => { owned.delete(value); }) } as unknown as DeviceSession;
  const pipelines = { output: { __kind: "sdr-pipeline", getBindGroupLayout: () => ({ __kind: "bgl" }) } } as unknown as Pipelines;
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn((_descriptor: unknown) => pass) };
  const source = { width: 32, height: 16, createView: vi.fn(() => ({})) } as unknown as GPUTexture;
  return { owned, device, session, pipelines, pass, encoder, source, hdrPipeline };
}
afterEach(() => vi.unstubAllGlobals());

const HDR_POLICY: HdrDisplayPolicy = Object.freeze({
  mode: "hdr", strategy: "extended-linear", failClosed: false, reason: "hdr-active",
});

async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/** HDR settings uniform 写入(16B=4 float);queue 上还有 output/author 等其它 uniform 写入。 */
function hdrWrites(device: ReturnType<typeof hdrFixture>["device"]): Float32Array[] {
  return device.queue.writeBuffer.mock.calls
    .map(call => call[2] as Float32Array).filter(data => data instanceof Float32Array && data.length === 4);
}

describe("I-C21 PbrOutputBindings HDR present —— 默认关回归", () => {
  it("不传 policy:hdrDisplay 为 undefined,encode 走既有 SDR 管线,present 描述符零漂移", async () => {
    const f = hdrFixture();
    const output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false);
    expect(output.hdrDisplay).toBeUndefined();
    output.present(f.encoder as unknown as GPUCommandEncoder, f.source, undefined, false);
    expect(f.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({ label: "Deep display output" }));
    expect(f.pass.setPipeline).toHaveBeenCalledWith(f.pipelines.output);
    expect(f.device.createShaderModule).not.toHaveBeenCalled();
    output.dispose();
    // 既有合同形状逐字段保持(缺省 spatialAa=true = 旧行为;hdr 第三参缺省 false)。
    const legacyDefault = describePbrPresentPasses("bloom-hdr");
    expect(legacyDefault.claims[1]).toEqual({ id: "surface", access: "write", format: "swapchain",
      sampleCount: 1, usages: ["render-attachment"], sizeRole: "independent" });
    expect(legacyDefault.gpuPassCount).toBe(2);
    expect(legacyDefault.unplannedAttachments?.[0]?.id).toBe("spatial-aa-intermediate");
    const legacyNoAa = describePbrPresentPasses("bloom-hdr", false);
    expect(legacyNoAa.gpuPassCount).toBe(1);
    expect(legacyNoAa.unplannedAttachments).toBeUndefined();
    await settle();
  });
});

describe("I-C21 PbrOutputBindings HDR present —— 激活与直出", () => {
  it("构造 opt-in:管线异步创建后 state=active,present 用 HDR 变体直出(SMAA 旁路)", async () => {
    const f = hdrFixture();
    const output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false, HDR_POLICY);
    expect(output.hdrDisplay?.state).toBe("activating");
    await settle();
    expect(output.hdrDisplay).toMatchObject({ state: "active", policy: HDR_POLICY });
    output.present(f.encoder as unknown as GPUCommandEncoder, f.source, undefined, false);
    expect(f.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({ label: "Deep HDR display output" }));
    expect(f.pass.setPipeline).toHaveBeenCalledWith(f.hdrPipeline);
    expect(f.pass.setPipeline).not.toHaveBeenCalledWith(f.pipelines.output);
    // 首次编码写入一次 HDR 设置 uniform:extended-linear → [0, 203, 0, 8]。
    const writes = hdrWrites(f.device);
    expect(writes.length).toBe(1);
    expect([...writes[0]!]).toEqual([0, HDR_REFERENCE_WHITE_NITS, 0, DEFAULT_EXTENDED_HEADROOM]);
    output.dispose();
  });

  it("HDR 激活时 captureSource 显式拒绝(SDR shader provenance 不适用 HDR 域)", async () => {
    const f = hdrFixture();
    const output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false, HDR_POLICY);
    await settle();
    expect(() => output.present(f.encoder as unknown as GPUCommandEncoder, f.source, undefined, false, undefined, true))
      .toThrow(/HDR display present has no SDR shader provenance/);
    output.dispose();
  });

  it("运行时切换:applyHdrDisplay(sdr) 复位回 SDR;再次 applyHdrDisplay(hdr) 重走激活", async () => {
    const f = hdrFixture();
    const output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false, HDR_POLICY);
    await vi.waitFor(() => {
      if (output.hdrDisplay?.state !== "active") throw new Error("first activation pending");
    });
    output.applyHdrDisplay(resolveHdrDisplayPolicy(undefined));
    expect(output.hdrDisplay).toBeUndefined();
    output.present(f.encoder as unknown as GPUCommandEncoder, f.source, undefined, false);
    expect(f.pass.setPipeline).toHaveBeenCalledWith(f.pipelines.output);
    output.applyHdrDisplay({ mode: "hdr", strategy: "pq-2020", failClosed: false, reason: "hdr-active", pqPeakNits: 1600 });
    await vi.waitFor(() => {
      if (output.hdrDisplay?.state !== "active") throw new Error("second activation pending");
    });
    output.present(f.encoder as unknown as GPUCommandEncoder, f.source, undefined, false);
    // 复位后的 present 走 SDR(不写 HDR uniform);全测唯一一次 4-float 写 = 新策略重写。
    const writes = hdrWrites(f.device);
    expect(writes.length).toBe(1);
    expect([...writes[0]!]).toEqual([1, HDR_REFERENCE_WHITE_NITS, 1600, DEFAULT_EXTENDED_HEADROOM]);
    output.dispose();
  });
});

describe("I-C21 PbrOutputBindings HDR present —— fail-closed 回 SDR", () => {
  it("管线创建失败:state=fallback + 原因码 hdr-pipeline-failed,present 仍走 SDR 链", async () => {
    const f = hdrFixture();
    f.device.createRenderPipelineAsync = vi.fn(async () => { throw new Error("unsupported format"); });
    const output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false,
      { mode: "hdr", strategy: "pq-2020", failClosed: false, reason: "hdr-active", pqPeakNits: 1000 });
    await settle();
    expect(output.hdrDisplay).toMatchObject({ state: "fallback", fallbackReason: "hdr-pipeline-failed" });
    output.present(f.encoder as unknown as GPUCommandEncoder, f.source, undefined, false);
    expect(f.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({ label: "Deep display output" }));
    expect(f.pass.setPipeline).toHaveBeenCalledWith(f.pipelines.output);
    output.dispose();
  });

  it("WGSL 编译错误以行号聚合抛出(工厂显式失败,不静默)", async () => {
    const f = hdrFixture();
    f.device.createShaderModule = vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [
      { type: "error", lineNum: 12, message: "unknown identifier" },
      { type: "warning", lineNum: 13, message: "unused" },
    ] }) })) as never;
    const { createHdrDisplayPipeline } = await import("./pbrHdrDisplayPipeline.js");
    const { createHdrDisplayAuthorLayout } = await import("./pbrHdrDisplayPipeline.js");
    await expect(createHdrDisplayPipeline(f.device as unknown as GPUDevice, "rgba16float",
      createHdrDisplayAuthorLayout(f.device as unknown as GPUDevice))).rejects.toThrow(/L12: unknown identifier/);
  });

  it("dispose 后激活请求显式抛错;激活后 dispose 不炸(竞态迟到成功销毁缓冲)", async () => {
    const f = hdrFixture();
    const output = new PbrOutputBindings(f.session, f.pipelines, () => 0, false);
    output.dispose();
    expect(() => output.applyHdrDisplay(HDR_POLICY)).toThrow(/disposed/);
    const output2 = new PbrOutputBindings(f.session, f.pipelines, () => 0, false, HDR_POLICY);
    await settle();
    expect(output2.hdrDisplay?.state).toBe("active");
    output2.dispose();
  });
});

describe("I-C21 present 描述符 HDR 形态(计划对拍面)", () => {
  it("hdr=true:surface 格式 rgba16float、无 spatial-aa unplanned、单 pass", () => {
    const hdr = describePbrPresentPasses("bloom-hdr", true, true);
    expect(hdr.claims[1]).toEqual({ id: "surface", access: "write", format: "rgba16float",
      sampleCount: 1, usages: ["render-attachment"], sizeRole: "independent" });
    expect(hdr.unplannedAttachments).toBeUndefined();
    expect(hdr.gpuPassCount).toBe(1);
    const hdrNoAa = describePbrPresentPasses("upscale-hdr", false, true);
    expect(hdrNoAa.claims[0]?.sizeRole).toBe("display");
    expect(hdrNoAa.gpuPassCount).toBe(1);
  });
});
