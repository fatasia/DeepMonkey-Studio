import { describe, expect, it, vi } from "vitest";
import { EditorOverlayPass, editorOverlayShader } from "./editorOverlayPass.js";
import { snapshotEditorOverlay, EDITOR_OVERLAY_MAX_VERTICES } from "./editorOverlayTypes.js";
import type { DeviceSession } from "./deviceSession.js";

function snapshot(revision = 1) {
  return { revision, vertices: new Float32Array([-0.5, 0, 0, 1, 1, 0, 0, 0.5,
    0.5, 0, 0, 1, 1, 0, 0, 0.5, 0, 0.5, 0, 1, 1, 0, 0, 0.5]) };
}
function fixture() {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, COPY_DST: 8 });
  const writeBuffer = vi.fn(), release = vi.fn(), createBuffer = vi.fn(() => ({}));
  const createRenderPipeline = vi.fn(() => ({})), session = { format: "bgra8unorm", own: (value: unknown) => value, release,
    device: { queue: { writeBuffer }, createBuffer, createShaderModule: vi.fn(), createRenderPipeline } } as unknown as DeviceSession;
  const pass = { setPipeline: vi.fn(), setVertexBuffer: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const encoder = { beginRenderPass: vi.fn(() => pass) };
  const owner = new EditorOverlayPass(session);
  return { owner, writeBuffer, release, createBuffer, createRenderPipeline, pass, encoder,
    encode: (value = snapshot()) => owner.encode(encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, value) };
}
describe("editor overlay ownership and rendering", () => {
  it("grows only for larger geometry and writes the final GPU timestamp on its own pass", () => {
    const f = fixture(); f.encode();
    const big = { revision: 2, vertices: new Float32Array([...snapshot().vertices, ...snapshot().vertices]) };
    f.encode(big); expect(f.createBuffer).toHaveBeenCalledTimes(2); expect(f.release).toHaveBeenCalledTimes(1);
    f.encode(snapshot(3)); expect(f.createBuffer).toHaveBeenCalledTimes(2);
    const queries = {} as GPUQuerySet;
    f.owner.encode(f.encoder as unknown as GPUCommandEncoder, {} as GPUTextureView, snapshot(3), queries);
    expect(f.encoder.beginRenderPass.mock.calls.at(-1)![0]).toMatchObject({ timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } });
    f.owner.dispose(); expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("copies input and rejects nonfinite, invalid colors and oversized geometry", () => {
    const source = snapshot(), copy = snapshotEditorOverlay(source); source.vertices[0] = 0;
    expect(copy.vertices[0]).toBe(-0.5);
    for (const [index, value] of [[0, NaN], [0, Infinity], [4, -1], [7, 2]]) {
      const bad = snapshot(); bad.vertices[index!] = value!; expect(() => snapshotEditorOverlay(bad)).toThrow();
    }
    expect(() => snapshotEditorOverlay({ revision: 0, vertices: new Float32Array((EDITOR_OVERLAY_MAX_VERTICES + 3) * 8) })).toThrow("budget");
    expect(() => snapshotEditorOverlay(snapshot(-1))).toThrow();
  });
  it("uses the session format, load pass, premultiplied blend and no depth attachment", () => {
    const f = fixture(); expect(f.encode()).toBe(1);
    const descriptor = f.createRenderPipeline.mock.calls[0]![0] as GPURenderPipelineDescriptor;
    expect(descriptor.fragment!.targets[0]!.format).toBe("bgra8unorm");
    expect(descriptor.fragment!.targets[0]!.blend!.color.srcFactor).toBe("one");
    expect(f.encoder.beginRenderPass.mock.calls[0]![0]).not.toHaveProperty("depthStencilAttachment");
    expect(editorOverlayShader("rgba8unorm-srgb")).toContain("pow(");
    expect(editorOverlayShader("bgra8unorm")).not.toContain("pow(");
    expect(editorOverlayShader("bgra8unorm")).toContain("color * in.color.a"); f.owner.dispose();
  });
  it("reuses static snapshots and rejects mutation without a revision", () => {
    const f = fixture(), value = snapshot(); f.encode(value); f.encode(value);
    expect(f.writeBuffer).toHaveBeenCalledTimes(1);
    value.vertices[0] = -0.25; expect(() => f.encode(value)).toThrow("revision");
    f.encode({ ...value, revision: 2 }); expect(f.writeBuffer).toHaveBeenCalledTimes(2);
    expect(f.createBuffer).toHaveBeenCalledTimes(1);
    expect(() => f.encode(snapshot())).toThrow("backwards"); f.owner.dispose();
  });
  it("invalidates reused contents after upload failure and supports retry/cancelled encoder without a commit", () => {
    const f = fixture(); f.encode();
    const next = snapshot(2); next.vertices[0] = -0.2;
    f.writeBuffer.mockImplementationOnce(() => { throw new Error("upload"); });
    expect(() => f.encode(next)).toThrow("upload");
    expect(f.pass.draw).toHaveBeenCalledTimes(1);
    f.encode(next); f.encode(next); expect(f.pass.draw).toHaveBeenCalledTimes(3);
    f.owner.dispose(); f.owner.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(() => f.encode(next)).toThrow("disposed");
  });
});
