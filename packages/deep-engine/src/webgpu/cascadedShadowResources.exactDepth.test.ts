import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import { packCascadedShadowUniform } from "../shadows/cascadedShadowShader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import type { DeviceSession } from "./deviceSession.js";
import { CascadedShadowResources, PBR_CASCADE_COUNT, PBR_CASCADE_MAP_SIZE } from "./cascadedShadowResources.js";
import type { Pipelines } from "./pipelines.js";

interface FakeResource { readonly destroy: ReturnType<typeof vi.fn> }
function fixture(limitOverrides: Partial<{ maxTextureDimension2D: number; maxTextureArrayLayers: number }> = {}) {
  const owned = new Set<FakeResource>(), views: GPUTextureViewDescriptor[] = [], writes: ArrayBufferView[] = [];
  const bufferDescriptors: GPUBufferDescriptor[] = [];
  const texture = { destroy: vi.fn(), createView: vi.fn((descriptor: GPUTextureViewDescriptor = {}) => {
    views.push(descriptor); return { descriptor } as GPUTextureView;
  }) } as unknown as GPUTexture & FakeResource;
  const buffers: Array<GPUBuffer & FakeResource> = [];
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, ...limitOverrides },
    queue: { writeBuffer: vi.fn((_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) => writes.push(data)) },
    createTexture: vi.fn(() => texture), createSampler: vi.fn(() => ({ kind: "sampler" })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      bufferDescriptors.push(descriptor);
      const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & FakeResource; buffers.push(buffer); return buffer;
    }),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor })),
  };
  const session = { device, own<T extends FakeResource>(value: T) { owned.add(value); return value; },
    release(value: FakeResource) { if (owned.delete(value)) value.destroy(); } };
  const pipelines = { cascadedShadowLayout: { kind: "csm" },
    shadow: { getBindGroupLayout: vi.fn(() => ({ kind: "shadow" })) } } as unknown as Pipelines;
  return { session: session as unknown as DeviceSession, device, pipelines, texture, buffers, bufferDescriptors,
    owned, views, writes };
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 4, COPY_DST: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input = Object.freeze({ eye: [4, 3, 5] as const, target: [0, 0, 0] as const,
  verticalFovRadians: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 1_000, extent: 10 });

describe("exact CSM depth contract", () => {
  const exact = { cascadeCount: 4, shadowMapSize: 2048, splitLambda: 0.7, blendRatio: 0, depthBias: 0.00075 };
  const view = { ...input, aspect: 1, far: 40, extent: 8, lightDirection: [0.6, -0.7, -Math.sqrt(0.15)] as const };
  const matrices = (plan: ReturnType<typeof planCascadedShadows>) => plan.cascades.map(c => Array.from(c.viewProjection));
  const bytes = (v: Float32Array) => Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));

  it("uploads exactly the existing planner ABI with declared depth padding and maximum distance", () => {
    const f = fixture(), profile = { ...exact, depthPadding: 10, maxShadowDistance: 30 };
    const shadows = new CascadedShadowResources(f.session, f.pipelines, { exactProfile: profile });
    const frame = shadows.prepare(view, false);
    const expected = planCascadedShadows({ ...view, far: 30 }, view.lightDirection, profile);
    expect(matrices(frame.plan)).toEqual(matrices(expected));
    const actualUpload = f.writes.at(-5) as Float32Array;
    expect(bytes(actualUpload)).toEqual(bytes(packCascadedShadowUniform(expected, 0.00075)));
    expect(frame.plan.splitDepths.at(-1)).toBe(30);
    shadows.dispose();
  });

  it("preserves derived defaults and updates padding when extent changes but shadow far remains 40", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    const first = shadows.prepare(view, false);
    const expected = planCascadedShadows(view, view.lightDirection, {
      ...shadows.selection.profile.options, maxShadowDistance: 40, depthPadding: 1.6 });
    expect(matrices(first.plan)).toEqual(matrices(expected)); shadows.commit();
    const changed = shadows.prepare({ ...view, extent: 12 }, false);
    expect(changed.render).toBe(true); expect(changed.plan.splitDepths.at(-1)).toBe(40);
    expect(matrices(changed.plan)).not.toEqual(matrices(first.plan));
    shadows.commit(); expect(shadows.prepare({ ...view, extent: 12 }, false).render).toBe(false);
    shadows.dispose();
  });

  it("snapshots both exact fields and suppresses extent-only work when actual matrices are unchanged", () => {
    const f = fixture(), profile = { ...exact, depthPadding: 10, maxShadowDistance: 30 };
    const shadows = new CascadedShadowResources(f.session, f.pipelines, { exactProfile: profile });
    const first = shadows.prepare(view, false); shadows.commit();
    profile.depthPadding = 100; profile.maxShadowDistance = 5;
    expect(shadows.prepare({ ...view, extent: 12 }, false)).toMatchObject({ render: false, plan: first.plan });
    shadows.dispose();
  });

  it("clamps exact distance to the camera far plane and rejects incompatible near values", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines,
      { exactProfile: { ...exact, depthPadding: 0, maxShadowDistance: 100 } });
    expect(shadows.prepare(view, false).plan.splitDepths.at(-1)).toBe(40); shadows.dispose();
    const small = new CascadedShadowResources(f.session, f.pipelines,
      { exactProfile: { ...exact, maxShadowDistance: 0.05 } });
    expect(() => small.prepare(view, false)).toThrow("maximum shadow distance"); small.dispose();
  });

  it("rejects malformed exact depth fields before allocating GPU resources", () => {
    const f = fixture();
    for (const depthPadding of [NaN, Infinity, -1, 1_000_001])
      expect(() => new CascadedShadowResources(f.session, f.pipelines,
        { exactProfile: { ...exact, depthPadding } })).toThrow("depth padding");
    for (const maxShadowDistance of [NaN, Infinity, -1, 0, 1_000_001])
      expect(() => new CascadedShadowResources(f.session, f.pipelines,
        { exactProfile: { ...exact, maxShadowDistance } })).toThrow("maximum shadow distance");
    expect(f.device.createTexture).not.toHaveBeenCalled(); expect(f.owned.size).toBe(0);
  });
});
