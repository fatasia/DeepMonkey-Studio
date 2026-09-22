import { describe, expect, it, vi } from "vitest";
import { drawPacketBatches, type PacketDrawPhase } from "./packetDraw.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketCullingResources } from "./packetCulling.js";
import type { PacketDeformationDrawContext } from "./packetDeformationDraw.js";
import type { Pipelines } from "./pipelines.js";

function fixture(phase: PacketDrawPhase = "opaque") {
  const source = { key: "posed", geometry: "g", pose: "p", count: 128,
    alphaMode: phase === "transparent" ? "BLEND" : "OPAQUE", mirrored: false, doubleSided: false };
  const batch = { source, buffer: {}, previousBuffer: {} } as unknown as CachedPacketBatch;
  const batches = new Map([[source.key, batch]]);
  const mesh = { indexCount: 3, draw: vi.fn(), drawIndirect: vi.fn() };
  const geometries = new Map([["g", { mesh } as unknown as CachedPacketGeometry]]);
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn() };
  const culling = { phase: vi.fn(() => { throw new Error("Static bounds consumed"); }), isDynamicPhase: vi.fn(() => false) };
  const pipelines = { deformationPlainLayout: {}, mainPipelines: new Map([
    ["plain/depth/ccw", "dynamic-main"], ["plain/blend/ccw", "dynamic-oit"],
    ["normal/depth/ccw", "dynamic-normal"],
  ]), shadowPipelines: new Map([["solid/ccw", "dynamic-shadow"]]) } as unknown as Pipelines;
  const group = {} as GPUBindGroup;
  const resolve = vi.fn(() => ({ pose: "p", pipelines, group, stale: false }));
  const context: PacketDeformationDrawContext = { resolve };
  const draw = (value: PacketDeformationDrawContext | undefined = context) => drawPacketBatches(
    pass as unknown as GPURenderPassEncoder, {} as Pipelines, phase, batches, geometries,
    culling as unknown as PacketCullingResources, undefined, undefined, true, 2, false, true, value);
  return { source, batch, batches, mesh, pass, culling, pipelines, group, resolve, context, draw };
}

describe("packet deformation draw routing", () => {
  it.each(["opaque", "transparent", "shadow"] as const)("draws %s using pose bindings without static culling", phase => {
    const f = fixture(phase);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 128 });
    expect(f.pass.setBindGroup).toHaveBeenCalledWith(1, f.group);
    expect(f.culling.phase).not.toHaveBeenCalled();
    expect(f.mesh.draw).toHaveBeenCalledWith(f.pass, f.batch.buffer, 128, false,
      phase === "shadow" ? undefined : f.batch.previousBuffer);
    expect(f.resolve).toHaveBeenCalledWith(f.source, phase, true);
  });

  it("requires the current culling owner result for indirect draws", () => {
    const f = fixture();
    const dynamic = { compacted: {}, compactedPrevious: {}, indirect: {}, bounds: "deformed" };
    f.context.dynamicCulling = vi.fn(() => dynamic as never);
    f.culling.isDynamicPhase.mockReturnValue(true);
    f.draw();
    expect(f.mesh.drawIndirect).toHaveBeenCalledWith(f.pass, dynamic.compacted, dynamic.indirect, false, dynamic.compactedPrevious);
    expect(f.context.dynamicCulling).toHaveBeenCalledWith(f.source, "opaque", 2);
    expect(f.culling.phase).not.toHaveBeenCalled();
    expect(f.culling.isDynamicPhase).toHaveBeenCalledWith(dynamic, f.source, "opaque", 2);
    f.culling.isDynamicPhase.mockReturnValue(false);
    f.pass.setPipeline.mockClear();
    expect(() => f.draw()).toThrow("dynamic bounds");
    expect(f.pass.setPipeline).not.toHaveBeenCalled();
  });

  it("normal-mapped pose does not bind a static tangent stream", () => {
    const f = fixture();
    Object.assign(f.source, { textures: { normal: {} } });
    f.draw();
    expect(f.pass.setPipeline).toHaveBeenCalledWith("dynamic-normal");
    expect(f.mesh.draw.mock.calls[0]![3]).toBe(false);
  });

  it("binds a shared material table once without dynamic offsets", () => {
    const f = fixture();
    f.resolve.mockReturnValue({ ...f.resolve() });
    f.draw();
    expect(f.pass.setBindGroup).toHaveBeenCalledWith(1, f.group);
  });

  it("preflights owner evidence for every indirect candidate before drawing", () => {
    const f = fixture();
    f.batches.set("second", { ...f.batch, source: { ...f.batch.source, key: "second" } });
    f.context.dynamicCulling = () => ({ compacted: {}, compactedPrevious: {}, indirect: {}, bounds: "deformed" }) as never;
    f.culling.isDynamicPhase.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(() => f.draw()).toThrow("owner-verified");
    expect(f.pass.setPipeline).not.toHaveBeenCalled();
    expect(f.mesh.drawIndirect).not.toHaveBeenCalled();
  });

  it.each(["missing", "stale", "identity", "layout"])("rejects %s before drawing any batch", failure => {
    const f = fixture();
    const value = f.resolve();
    f.resolve.mockReturnValue(failure === "missing" ? undefined as never : {
      ...value, ...(failure === "stale" ? { stale: true } : {}),
      ...(failure === "identity" ? { pose: "other" } : {}),
      ...(failure === "layout" ? { pipelines: {} as Pipelines } : {}),
    });
    expect(() => f.draw()).toThrow(/deformation draw resources/);
    expect(f.pass.setPipeline).not.toHaveBeenCalled();
    expect(f.mesh.draw).not.toHaveBeenCalled();
  });

  it("rejects direct display and unmapped LOD", () => {
    expect(() => fixture("display").draw()).toThrow("direct display");
    const f = fixture(); Object.assign(f.source, { lod: {} });
    expect(() => f.draw()).toThrow("LOD");
    expect(f.resolve).not.toHaveBeenCalled();
  });
});
