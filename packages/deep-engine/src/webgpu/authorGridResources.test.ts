import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { AUTHOR_GRID_WGSL, AuthorGridResources } from "./authorGridResources.js";
import { authorGridUniforms, prepareAuthorGridTexture, type AuthorGridView } from "./authorGridTypes.js";
import type { DeviceSession } from "./deviceSession.js";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const source = (): AuthorGridView => ({ model: identity, color: [1, 1, 1, 0.5], texture: {
  id: "grid", revision: 1, semantic: "baseColor", width: 2, height: 2,
  data: new Uint8Array([255,255,255,255, 0,0,0,0, 255,255,255,255, 0,0,0,0]),
  sampler: { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8 } } });
function fixture() {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
  const release = vi.fn(), writeTexture = vi.fn(), createTexture = vi.fn(() => ({ createView: () => ({}) }));
  const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
  const session = { state: "ready", own: (v: unknown) => v, release, device: { createTexture, createRenderPipeline,
    createShaderModule: vi.fn(), createBuffer: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})), createSampler: vi.fn(),
    queue: { writeTexture, writeBuffer: vi.fn() } } };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }, encoder = { beginRenderPass: vi.fn(() => pass) };
  const owner = new AuthorGridResources(session as unknown as DeviceSession);
  return { session, owner, release, writeTexture, createTexture, createRenderPipeline, encoder,
    encode: (view?: AuthorGridView) => owner.encode(encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, {} as GPUTextureView, identity, identity, view) };
}
describe("authored world grid GPU ownership", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "author-grid.wgsl", "--input-kind", "wgsl"], { input: AUTHOR_GRID_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("retries partial pipeline initialization after uniform allocation failure", () => {
    const f = fixture(); f.session.device.createBuffer.mockImplementationOnce(() => { throw new Error("allocation"); });
    expect(() => f.encode(source())).toThrow("allocation"); expect(f.encode(source())).toBe(2);
    expect(f.createRenderPipeline).toHaveBeenCalledTimes(2); f.owner.dispose();
  });
  it("builds linear-light complete mips with one sRGB decode and owned bytes", () => {
    const input = source(), texture = prepareAuthorGridTexture(input.texture);
    expect(texture.format).toBe("rgba8unorm-srgb"); expect(texture.levels).toHaveLength(2);
    expect(texture.levels[1]!.data[0]).toBe(188); expect(texture.levels[1]!.data[3]).toBe(128);
    input.texture.data[0] = 0; expect(texture.levels[0]!.data[0]).toBe(255);
    expect(() => authorGridUniforms({ ...input, model: [NaN] }, identity)).toThrow();
    expect(() => prepareAuthorGridTexture({ ...input.texture, width: 3 })).toThrow("power-of-two");
  });
  it("loads HDR color with depth test but no depth writes, and reuses unchanged GPU texture", () => {
    const f = fixture(), view = source(); expect(f.encode()).toBe(0); expect(f.encode(view)).toBe(2); f.encode(view);
    f.encode({ ...source(), texture: { ...source().texture, data: source().texture.data.slice() } });
    expect(f.createTexture).toHaveBeenCalledTimes(1); expect(f.writeTexture).toHaveBeenCalledTimes(2);
    expect(f.createRenderPipeline).toHaveBeenCalledWith(expect.objectContaining({ depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "less-equal" } }));
    expect(f.encoder.beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({ depthStencilAttachment: expect.objectContaining({ depthReadOnly: true }) }));
    f.owner.dispose(); f.owner.dispose(); expect(f.release).toHaveBeenCalledTimes(2); expect(() => f.encode(view)).toThrow("unavailable");
  });
  it("keeps prior texture after failed replacement and retries a cancelled encoder safely", () => {
    const f = fixture(), first = source(); f.encode(first);
    f.writeTexture.mockImplementationOnce(() => { throw new Error("upload"); });
    const current = source(), next = { ...current, texture: { ...current.texture, revision: 2 } };
    expect(() => f.encode(next)).toThrow("upload"); f.encode(first); expect(f.createTexture).toHaveBeenCalledTimes(2);
    f.encode(next); f.encode(next); expect(f.createTexture).toHaveBeenCalledTimes(3);
    expect(() => f.encode(first)).toThrow("Stale author grid texture revision");
    f.session.state = "lost"; expect(() => f.encode(next)).toThrow("unavailable"); f.owner.dispose();
    expect(f.release).toHaveBeenCalledTimes(4);
  });
});
