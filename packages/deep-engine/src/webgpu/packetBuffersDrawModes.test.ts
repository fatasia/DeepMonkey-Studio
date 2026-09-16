import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";

function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: GPUBuffer[] = [], contents = new Map<GPUBuffer, number[]>();
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024 },
    createBuffer: vi.fn(({ label }: { label?: string }) => { const buffer = { label, destroy: vi.fn() } as unknown as GPUBuffer; allocated.push(buffer); return buffer; }),
    queue: { writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: Float32Array | Uint32Array) => { contents.set(buffer, Array.from(data)); }) } };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  const cache = new PacketBuffers(session as unknown as DeviceSession);
  const pass = { setPipeline: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const pipelines = { mainPipelines: new Map([
    [mainPipelineKey("plain", false, "ccw"), "main"], [mainPipelineKey("plain", false, "cw"), "mirror"],
    [mainPipelineKey("plain", false, "double"), "double"], [mainPipelineKey("plain", true, "ccw"), "blend"],
  ]), displayPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "display"]]),
  displayDirectionalPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "directional"]]), shadowPipelines: new Map([
    [shadowPipelineKey("solid", "ccw"), "shadow"], [shadowPipelineKey("solid", "cw"), "shadowMirror"],
    [shadowPipelineKey("solid", "double"), "shadowDouble"], [shadowPipelineKey("maskPlain", "ccw"), "shadowMask"],
  ]) } as unknown as Pipelines;
  const draw = (phase: "opaque" | "shadow" = "opaque") =>
    cache.draw(pass as unknown as GPURenderPassEncoder, pipelines, phase);
  const byLabel = (label: string) => allocated.filter(buffer => (buffer as GPUBuffer & { label?: string }).label === label);
  return { cache, owned, contents, pass, pipelines, draw, byLabel };
}

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function packet(): RenderPacket {
  return { geometries: [{ id: "g", revision: 0, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0, roughness: 0.5 }],
    instances: [{ id: "i", geometry: "g", material: "m", transform }] };
}

beforeEach(() => vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("packet draw modes", () => {
  it("keeps non-casters in the visible pass but out of the shadow pass after updates", () => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, instances: [p.instances[0]!, { ...p.instances[0]!, id: "no-shadow", castShadow: false }] });
    expect(f.draw()).toEqual({ drawCalls: 2, triangles: 2 });
    expect(f.draw("shadow")).toEqual({ drawCalls: 1, triangles: 1 });
    f.cache.updateInstances({ materials: p.materials, instances: [{ ...p.instances[0]!, castShadow: false }] });
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.draw("shadow")).toEqual({ drawCalls: 0, triangles: 0 });
  });
  it("shares geometry across mirrored batches and preserves winding in both passes", () => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, instances: [...p.instances, { ...p.instances[0]!, id: "mirror", transform: [-1, ...transform.slice(1)] }] });
    expect(f.owned.size).toBe(6); expect(f.draw()).toEqual({ drawCalls: 2, triangles: 2 });
    expect(f.pass.setPipeline.mock.calls).toEqual([["main"], ["mirror"]]);
    f.pass.setPipeline.mockClear(); f.draw("shadow");
    expect(f.pass.setPipeline.mock.calls).toEqual([["shadow"], ["shadowMirror"]]);
  });

  it("merges mirrored double-sided instances and disables culling in both passes", () => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, materials: [{ ...p.materials[0]!, doubleSided: true }], instances: [...p.instances,
      { ...p.instances[0]!, id: "mirror", transform: [-1, ...transform.slice(1)] }] });
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 2 });
    expect(f.pass.setPipeline).toHaveBeenLastCalledWith("double");
    const data = f.contents.get(f.byLabel("Deep packet instances")[0]!)!;
    expect([data[30], data[66]]).toEqual([1, -1]); expect([data[31], data[67]]).toEqual([1, 1]);
    f.pass.setPipeline.mockClear(); f.draw("shadow");
    expect(f.pass.setPipeline).toHaveBeenCalledOnce(); expect(f.pass.setPipeline).toHaveBeenCalledWith("shadowDouble");
  });

  it("keeps BLEND out of depth-writing passes and batches it for weighted OIT", () => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, materials: [{ ...p.materials[0]!, alphaMode: "BLEND", baseColorAlpha: 0.4 }], instances: [
      { ...p.instances[0]!, id: "near" },
      { ...p.instances[0]!, id: "far", transform: transform.map((value, index) => index === 14 ? -5 : value) },
    ] });
    expect(f.draw()).toEqual({ drawCalls: 0, triangles: 0 }); expect(f.draw("shadow")).toEqual({ drawCalls: 0, triangles: 0 });
    f.pass.setVertexBuffer.mockClear(); f.pass.setPipeline.mockClear();
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "transparent"))
      .toEqual({ drawCalls: 1, triangles: 2 });
    const buffers = f.pass.setVertexBuffer.mock.calls.filter(call => call[0] === 1).map(call => call[1] as GPUBuffer);
    expect(f.contents.get(buffers[0]!)!.filter((_value, index) => index % 36 === 11)).toEqual([0, -5]);
    expect(f.pass.setPipeline.mock.calls).toEqual([["blend"]]);
  });

  it.each([0, 0.3, 1])("writes author BLEND depth without opacity %s becoming alphaTest", baseColorAlpha => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, materials: [{ ...p.materials[0]!, alphaMode: "BLEND", baseColorAlpha }],
      instances: [p.instances[0]!, { ...p.instances[0]!, id: "disabled", castShadow: false }] });
    expect(f.draw("shadow")).toEqual({ drawCalls: 0, triangles: 0 });
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "shadow",
      undefined, true, 0, false, true)).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setPipeline.mock.calls).toEqual([["shadowMask"]]);
  });

  it("uses the cutout shadow pipeline for MASK while retaining the opaque phase", () => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, materials: [{ ...p.materials[0]!, alphaMode: "MASK", alphaCutoff: 0.25, baseColorAlpha: 0.5 }] });
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    const data = f.contents.get(f.byLabel("Deep packet instances")[0]!)!;
    expect(data[29]).toBe(0.25); expect(data[31]).toBe(2); expect(data[35]).toBe(0.5);
    f.pass.setPipeline.mockClear(); expect(f.draw("shadow")).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setPipeline).toHaveBeenCalledWith("shadowMask");
    f.pass.setPipeline.mockClear();
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "shadow", undefined, false, 0, false, true);
    expect(f.pass.setPipeline).toHaveBeenCalledWith("shadowMask");
  });

  it("retains cutout coverage for BLEND in color and author shadow passes", () => {
    const f = fixture(), p = packet();
    f.cache.set({ ...p, materials: [{ ...p.materials[0]!, alphaMode: "BLEND", alphaCutoff: 0.25, baseColorAlpha: 0.5 }] });
    const data = f.contents.get(f.byLabel("Deep packet instances")[0]!)!;
    expect(data[29]).toBe(0.25); expect(data[31]).toBe(6);
    expect(f.draw("shadow")).toEqual({ drawCalls: 0, triangles: 0 });
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "shadow", undefined, false, 0, false, true);
    expect(f.pass.setPipeline).toHaveBeenCalledWith("shadowMask");
  });

  it("uses the directional display variant without binding motion history", () => {
    const f = fixture(); f.cache.set(packet());
    expect(f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "display",
      undefined, false, 0, true)).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setPipeline).toHaveBeenCalledWith("directional");
    expect(f.pass.setVertexBuffer.mock.calls.some(call => call[0] === 2)).toBe(false);
  });
});
