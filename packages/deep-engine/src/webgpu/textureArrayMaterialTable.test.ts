import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { createTextureArrayMaterialTable, createTextureArrayMaterialTableLayout } from "./textureArrayMaterialTable.js";

function fixture(alignment = 256) {
  const owned = new Set<GPUBuffer>();
  const writes: ArrayBufferView[] = [];
  const device = { limits: { minUniformBufferOffsetAlignment: alignment },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: vi.fn() })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ descriptor })),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor })),
    queue: { writeBuffer: vi.fn((_buffer, _offset, data: ArrayBufferView) => writes.push(data)) } };
  const session = { device, own<T extends GPUBuffer>(buffer: T) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  return { device, session: session as unknown as DeviceSession, owned, writes };
}

const source = (arrayKey: string, layer: number, strength: number) => ({ arrayKey,
  textureEntries: [{ binding: 0, resource: {} as GPUTextureView }],
  layerIndices: [layer, 0, 0, 0, 0, 0, 0, 0],
  textures: { emissiveStrength: strength } });

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_DST: 8 });
});
afterEach(() => vi.unstubAllGlobals());

describe("shared texture-array material table", () => {
  it("packs tightly indexed parameter/index rows and interns groups by array combination", () => {
    const f = fixture();
    const layout = createTextureArrayMaterialTableLayout(f.device as unknown as GPUDevice);
    const table = createTextureArrayMaterialTable(f.session, layout,
      [source("same", 2, 1), source("same", 7, 3), source("other", 4, 5)]);
    expect(table.rowStride).toBe(192);
    expect(table.rows.map(row => row.materialRow)).toEqual([0, 1, 2]);
    expect(table.rows[0]!.group).toBe(table.rows[1]!.group);
    expect(table.rows[2]!.group).not.toBe(table.rows[0]!.group);
    expect(table.groupCount).toBe(2);
    expect(new Float32Array(f.writes[0]!.buffer)[39]).toBe(1);
    expect(new Float32Array(f.writes[0]!.buffer)[48 + 39]).toBe(3);
    expect(new Uint32Array(f.writes[0]!.buffer)[40]).toBe(2);
    expect(new Uint32Array(f.writes[0]!.buffer)[48 + 40]).toBe(7);
    table.dispose(); table.dispose();
    expect(f.owned.size).toBe(0);
  });

  it("uses shared storage bindings without occupying deformation bindings 11/12", () => {
    const f = fixture(64);
    createTextureArrayMaterialTableLayout(f.device as unknown as GPUDevice);
    const entries = f.device.createBindGroupLayout.mock.calls[0]![0].entries;
    expect(entries.filter(entry => entry.buffer?.type === "read-only-storage").map(entry => entry.binding)).toEqual([10]);
    expect(entries.some(entry => entry.buffer?.hasDynamicOffset)).toBe(false);
    expect(entries.some(entry => entry.binding === 11 || entry.binding === 12)).toBe(false);
  });

  it("rejects malformed rows before allocating shared buffers", () => {
    const f = fixture();
    const layout = createTextureArrayMaterialTableLayout(f.device as unknown as GPUDevice);
    expect(() => createTextureArrayMaterialTable(f.session, layout,
      [{ ...source("bad", 0, 1), layerIndices: [0, 1] }])).toThrow(/eight nonnegative/);
    expect(f.device.createBuffer).not.toHaveBeenCalled();
  });
});
