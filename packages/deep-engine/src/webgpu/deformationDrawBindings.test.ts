import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeformationDrawBindings } from "./deformationDrawBindings.js";
import type { GpuDeformationHistoryResult } from "./gpuDeformationHistoryTypes.js";
import type { MaterialBinding } from "./materialBindings.js";
import type { Pipelines } from "./pipelines.js";

beforeEach(() => vi.stubGlobal("GPUBufferUsage", { STORAGE: 128 }));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const device = { limits: { maxStorageBufferBindingSize: 1024 }, createBindGroup: vi.fn(descriptor => ({ descriptor })) };
  const pipelines = { deformationPlainLayout: {}, materialLayout: { material: {} } } as unknown as Pipelines;
  const buffer = () => ({ size: 144, usage: 128, mapState: "unmapped", destroy: vi.fn() }) as unknown as GPUBuffer;
  const a = buffer(), b = buffer();
  const streams: GpuDeformationHistoryResult = { current: a, previous: b, vertexCount: 3, outputStride: 48,
    sourceRevision: 0, poseRevision: 0, hasTangents: false, historyValid: true, updated: true };
  return { device, a, b, streams, bindings: new DeformationDrawBindings(device as unknown as GPUDevice, pipelines) };
}

it("binds both poses and reuses alternating history without changing borrowed buffers", () => {
  const f = fixture(), first = f.bindings.get("pose", f.streams);
  f.bindings.get("pose", { ...f.streams, current: f.b, previous: f.a });
  expect(f.bindings.get("pose", f.streams)).toBe(first);
  expect(f.device.createBindGroup).toHaveBeenCalledTimes(2);
  expect(f.device.createBindGroup.mock.calls[0]![0].entries).toEqual([
    { binding: 11, resource: { buffer: f.a, size: 144 } }, { binding: 12, resource: { buffer: f.b, size: 144 } },
  ]);
  f.bindings.dispose(); f.bindings.dispose();
  expect(f.a.destroy).not.toHaveBeenCalled(); expect(f.b.destroy).not.toHaveBeenCalled();
  expect(() => f.bindings.get("pose", f.streams)).toThrow("disposed");
});

it("preserves all material slots and rejects a missing normal-map tangent stream", () => {
  const f = fixture();
  const texture = { view: {}, sampler: {} };
  const material = { parameters: {}, base: texture, normal: texture } as unknown as MaterialBinding;
  expect(() => f.bindings.get("pose", f.streams, material)).toThrow("tangents");
  f.bindings.get("pose", { ...f.streams, hasTangents: true }, material);
  const entries = f.device.createBindGroup.mock.calls[0]![0].entries;
  expect(entries.map((entry: GPUBindGroupEntry) => entry.binding)).toEqual(Array.from({ length: 13 }, (_, i) => i));
  expect(entries[4].resource.buffer).toBe(material.parameters);
});

it("drops retired identities and leaves failed bindings retryable", () => {
  const f = fixture();
  f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
  expect(() => f.bindings.get("pose", f.streams)).toThrow("binding failed");
  f.bindings.get("pose", f.streams);
  f.bindings.retain(new Map());
  f.bindings.get("pose", f.streams);
  expect(f.device.createBindGroup).toHaveBeenCalledTimes(3);
  expect(() => f.bindings.get("pose", { ...f.streams, vertexCount: 4 })).toThrow("complete unmapped");
});

it("composes array-table buffers with deformation streams using the array layout", () => {
  const f = fixture(), arrayLayout = {}, fallbackLayout = {};
  const pipelines = (f.bindings as unknown as { pipelines: Pipelines }).pipelines;
  Object.assign(pipelines.materialLayout, { material: arrayLayout });
  Object.assign(pipelines, { textureArrayFallback: { materialLayout: { material: fallbackLayout } } });
  const row = { group: {}, materialRow: 0, arrayKey: "a", textureEntries: [{ binding: 0, resource: {} }],
    table: {} } as never;
  f.bindings.get("pose", f.streams, row);
  const descriptor = f.device.createBindGroup.mock.calls[0]![0];
  expect(descriptor.layout).toBe(arrayLayout);
  expect(descriptor.entries.map((entry: GPUBindGroupEntry) => entry.binding)).toEqual([0, 10, 11, 12]);
});
