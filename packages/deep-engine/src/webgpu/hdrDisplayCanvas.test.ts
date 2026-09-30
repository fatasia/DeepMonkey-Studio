import { afterEach, expect, it, vi } from "vitest";
import { probeHdrDisplayCanvas } from "./hdrDisplayCanvas.js";

function fixture(range = "high") {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, COPY_SRC: 1 });
  const actual = { format: "rgba16float", toneMapping: { mode: "extended" } };
  const context = { configure: vi.fn(), getConfiguration: vi.fn(() => actual), unconfigure: vi.fn() };
  const device = { pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as null | { message: string }) };
  const matchMedia = vi.fn((query: string) => ({ matches: query === `(dynamic-range: ${range})` }));
  const createElement = vi.fn(() => ({ getContext: () => context, width: 0, height: 0 }));
  const canvas = { ownerDocument: { defaultView: { matchMedia }, createElement } };
  const probe = (request = { enabled: true }) => probeHdrDisplayCanvas(device as unknown as GPUDevice, canvas as unknown as HTMLCanvasElement, request);
  return { actual, context, device, canvas, matchMedia, createElement, probe };
}
afterEach(() => vi.unstubAllGlobals());
it("performs no host or GPU capability operations when HDR is omitted or disabled", async () => {
  const f = fixture();
  expect((await f.probe({ enabled: false })).policy.reason).toBe("opt-out");
  expect(f.matchMedia).not.toHaveBeenCalled(); expect(f.createElement).not.toHaveBeenCalled(); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
});
it("records actual SDR media support without configuring or compiling any HDR resources", async () => {
  const f = fixture("standard"), result = await f.probe();
  expect(result).toMatchObject({ policy: { mode: "sdr", reason: "display-not-hdr" }, canvasProbePerformed: false });
  expect(f.createElement).not.toHaveBeenCalled(); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
});
it("requires an actually retained extended mode, then unconfigures only the temporary canvas", async () => {
  const f = fixture(), result = await f.probe();
  expect(result).toMatchObject({ policy: { mode: "hdr", strategy: "extended-linear" }, canvasProbePerformed: true });
  expect(f.context.configure).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba16float", toneMapping: { mode: "extended" }, usage: 17 }));
  expect(f.context.unconfigure).toHaveBeenCalledOnce(); expect(f.device.popErrorScope).toHaveBeenCalledOnce();
});
it("rejects ignored configuration fields instead of equating no synchronous exception to support", async () => {
  const f = fixture(); f.actual.toneMapping.mode = "standard";
  expect((await f.probe()).policy.reason).toBe("canvas-extended-tonemapping-unsupported");
  expect(f.context.unconfigure).toHaveBeenCalledOnce();
});
it("collects asynchronous validation failures and closes the temporary surface", async () => {
  const f = fixture(); f.device.popErrorScope.mockResolvedValue({ message: "format rejected" });
  expect((await f.probe()).policy.reason).toBe("hdr-canvas-format-unsupported");
  expect(f.context.unconfigure).toHaveBeenCalledOnce();
});
it("keeps encoded PQ and HLG requests out of a physical extended-linear canvas", async () => {
  const f = fixture();
  for (const strategy of ["pq-2020", "hlg-2020"] as const) {
    const result = await probeHdrDisplayCanvas(f.device as unknown as GPUDevice, f.canvas as never, { enabled: true, strategy });
    expect(result.policy).toMatchObject({ mode: "sdr", reason: "invalid-probe" });
  }
  expect(f.matchMedia).not.toHaveBeenCalled(); expect(f.createElement).not.toHaveBeenCalled();
});

// 启动链保证(DeviceSession.open 直接 await 探测):探测路径任何宿主/GPU 异常
// 都不得向调用方逃逸,必须降级为显式 SDR 原因码。
it("survives a throwing temporary canvas acquisition and degrades to an explicit SDR reason", async () => {
  const f = fixture();
  f.createElement.mockImplementation(() => { throw new Error("createElement blocked"); });
  const result = await f.probe();
  expect(result.policy).toMatchObject({ mode: "sdr", failClosed: true, reason: "canvas-extended-tonemapping-unsupported" });
  expect(result.canvasProbePerformed).toBe(true);
  expect(f.device.popErrorScope).not.toHaveBeenCalled();
});
it("survives a throwing webgpu context acquisition and still resolves", async () => {
  const f = fixture();
  f.createElement.mockImplementation(() => ({ getContext: () => { throw new Error("context blocked"); }, width: 0, height: 0 }));
  const result = await f.probe();
  expect(result.policy).toMatchObject({ mode: "sdr", reason: "canvas-extended-tonemapping-unsupported" });
  expect(f.context.unconfigure).not.toHaveBeenCalled();
});
it("does not escape a rejecting popErrorScope and still closes the temporary surface", async () => {
  const f = fixture(); f.device.popErrorScope.mockRejectedValue(new Error("scope mismatch"));
  const result = await f.probe();
  // 校验作用域读不到:rgba16float 能力视为未确认,fail-closed 回显式 SDR 原因码。
  expect(result.policy).toMatchObject({ mode: "sdr", failClosed: true, reason: "hdr-canvas-format-unsupported" });
  expect(f.context.unconfigure).toHaveBeenCalledOnce();
});
it("skips error scope bookkeeping when pushErrorScope itself throws", async () => {
  const f = fixture();
  f.device.pushErrorScope.mockImplementation(() => { throw new Error("device rejected scope"); });
  const result = await f.probe();
  expect(result.policy).toMatchObject({ mode: "sdr", reason: "canvas-extended-tonemapping-unsupported" });
  expect(f.device.popErrorScope).not.toHaveBeenCalled();
  expect(f.context.unconfigure).toHaveBeenCalledOnce();
});
it("keeps a closed probe on a missing temporary context instead of treating it as supported", async () => {
  const f = fixture();
  f.createElement.mockImplementation(() => ({ getContext: () => null, width: 0, height: 0 }));
  const result = await f.probe();
  expect(result.policy).toMatchObject({ mode: "sdr", reason: "canvas-extended-tonemapping-unsupported" });
  expect(f.device.popErrorScope).toHaveBeenCalledOnce();
  expect(f.context.unconfigure).not.toHaveBeenCalled();
});
