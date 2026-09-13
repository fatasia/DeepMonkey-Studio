import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareRenderPacket,
  type GeometryResource,
  type PreparedPacket,
} from "../renderPacket.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { createPacketResidencyDomain } from "./packetResidencyDomain.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, first = 0): GeometryResource {
  return { id, revision: 3,
    vertices: new Float32Array([first, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}

function texture(id: string, first = 11): DecodedTexture {
  const data = new Uint8Array(16).fill(11); data[0] = first;
  return { id, revision: 7, semantic: "baseColor", width: 2, height: 2, data,
    mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4).fill(22) }] };
}

function packet(geometryId = "mesh", textureId = "base", first = 0,
  instance = "instance"): PreparedPacket {
  return prepareRenderPacket({ geometries: [geometry(geometryId, first)], textures: [texture(textureId)],
    materials: [{ id: `mat-${instance}`, baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: textureId } }],
    instances: [{ id: instance, geometry: geometryId, material: `mat-${instance}`, transform: TRANSFORM }],
  });
}

function gpuFixture() {
  const owned = new Set<{ destroy(): void }>();
  const destroyable = () => ({ destroy: vi.fn() });
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1_000_000 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    createBuffer: vi.fn(() => destroyable() as unknown as GPUBuffer),
    createTexture: vi.fn(() => ({ ...destroyable(), createView: vi.fn(() => ({})) }) as unknown as GPUTexture),
    createSampler: vi.fn(() => ({} as GPUSampler)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, device, owned };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

describe("createPacketResidencyDomain", () => {
  it("shares exact resources across packets and uploads them only once", async () => {
    const fixture = gpuFixture();
    const domain = createPacketResidencyDomain(fixture.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    const first = domain.registerPacket("first", packet("shared-mesh", "shared-base", 0, "a"));
    const second = domain.registerPacket("second", packet("shared-mesh", "shared-base", 0, "b"));

    const a = await domain.load(first, { frame: 1 });
    const bufferUploads = fixture.device.createBuffer.mock.calls.length;
    const textureUploads = fixture.device.createTexture.mock.calls.length;
    const b = await domain.load(second, { frame: 2 });

    expect(domain.residentBytes).toBe(152);
    expect(domain.telemetrySnapshot()).toMatchObject({ registeredResourceCount: 2,
      residentResourceCount: 2, residentBytes: 152, lastAppliedFrame: { frame: 2 } });
    expect(fixture.device.createBuffer).toHaveBeenCalledTimes(bufferUploads);
    expect(fixture.device.createTexture).toHaveBeenCalledTimes(textureUploads);
    expect(a.geometry("shared-mesh")?.mesh).toBe(b.geometry("shared-mesh")?.mesh);
    expect(a.texture("shared-base")?.texture).toBe(b.texture("shared-base")?.texture);
    a.release(); b.release(); domain.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("fails closed when equal kind and id have different source bytes", async () => {
    const fixture = gpuFixture();
    const domain = createPacketResidencyDomain(fixture.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    const ticket = domain.registerPacket("valid", packet("shared", "texture", 0));

    expect(() => domain.registerPacket("conflict", packet("shared", "texture", 0.25)))
      .toThrow("conflicts with an existing source");
    const projection = await domain.load(ticket, { frame: 1 });
    expect(projection.geometry("shared")?.sourceRevision).toBe(3);
    projection.release(); domain.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("accounts independent packet resources against the same budget", async () => {
    const fixture = gpuFixture();
    const domain = createPacketResidencyDomain(fixture.session,
      { maxResidentBytes: 304, maxUploadBytesPerFrame: 152 });
    const a = domain.registerPacket("a", packet("mesh-a", "texture-a", 0, "a"));
    const b = domain.registerPacket("b", packet("mesh-b", "texture-b", 0, "b"));
    const projectionA = await domain.load(a, { frame: 1 });
    const projectionB = await domain.load(b, { frame: 2 });

    expect(domain.residentBytes).toBe(304);
    expect(fixture.device.createTexture).toHaveBeenCalledTimes(2);
    projectionA.release(); projectionB.release(); domain.dispose(); expect(fixture.owned.size).toBe(0);
  });

  it("rejects foreign and stale tickets without touching the runtime", async () => {
    const fixtureA = gpuFixture(), fixtureB = gpuFixture();
    const a = createPacketResidencyDomain(fixtureA.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    const b = createPacketResidencyDomain(fixtureB.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    const ticket = a.registerPacket("packet", packet());

    await expect(b.load(ticket, { frame: 1 })).rejects.toMatchObject({ code: "unbound-runtime" });
    expect(b.residentBytes).toBe(0);
    a.unregister(ticket);
    await expect(a.load(ticket, { frame: 1 })).rejects.toMatchObject({ code: "unbound-runtime" });
    a.dispose(); b.dispose();
  });

  it("defers destruction across domain disposal until every projection lease releases", async () => {
    const fixture = gpuFixture();
    const domain = createPacketResidencyDomain(fixture.session,
      { maxResidentBytes: 152, maxUploadBytesPerFrame: 152 });
    const ticket = domain.registerPacket("packet", packet());
    const projection = await domain.load(ticket, { frame: 1 });
    const ownedBefore = fixture.owned.size;

    domain.dispose();
    expect(domain.disposed).toBe(true); expect(domain.retiredBytes).toBe(152);
    expect(fixture.owned.size).toBe(ownedBefore);
    projection.release(); projection.release();
    expect(domain.retiredBytes).toBe(0); expect(fixture.owned.size).toBe(0);
  });
});
