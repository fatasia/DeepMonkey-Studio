import { afterEach, describe, expect, it, vi } from "vitest";
import { PbrBackgroundPass } from "./pbrBackgroundPass.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

afterEach(() => vi.unstubAllGlobals());
const view = { eye: [0, 0, 10] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0, 0, 0] as const, floor: [0, 0, 0] as const, exposure: 1, roughness: 1, panoramaBackground: {} };
describe("panorama GPU draw", () => {
  it.each([false, true])("matches MRT=%s while leaving geometric depth untouched", mrt => {
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
    const createBindGroup = vi.fn(() => ({})), writeBuffer = vi.fn();
    const device = { createShaderModule: () => ({}), createRenderPipeline, createBuffer: () => ({}),
      queue: { writeBuffer }, createBindGroup };
    const session = { device, own: (r: object) => r, release: vi.fn() } as unknown as DeviceSession;
    const background = new PbrBackgroundPass(session, mrt);
    const descriptor = createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
    expect(descriptor.depthStencil).toMatchObject({ depthWriteEnabled: false, depthCompare: "always" });
    expect(Array.from(descriptor.fragment!.targets)).toHaveLength(mrt ? 4 : 1);
    const environment = { panorama: { view: {}, sampler: {} } } as StudioEnvironment;
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() };
    background.prepare(view, environment, 1)(pass as unknown as GPURenderPassEncoder);
    background.prepare(view, environment, 1)(pass as unknown as GPURenderPassEncoder);
    expect(pass.draw).toHaveBeenCalledTimes(2); expect(pass.draw).toHaveBeenLastCalledWith(3);
    expect(createBindGroup).toHaveBeenCalledTimes(1);
    background.prepare(view, { panorama: { view: {}, sampler: {} } } as StudioEnvironment, 1);
    expect(createBindGroup).toHaveBeenCalledTimes(2);
    expect(() => background.prepare(view, {} as StudioEnvironment, 1)).toThrow("staged HDR");
  });
});
