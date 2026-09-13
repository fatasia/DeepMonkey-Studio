import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket, type GeometryResource, type PreparedPacket } from "../renderPacket.js";
import { PacketResidencyLoadError } from "./packetResidencyLoader.js";
import type {
  PacketResidencyDomain,
  PacketResidencyTicket,
} from "./packetResidencyDomain.js";
import {
  createPacketResidencyWorkingSet,
  PacketResidencyWorkingSetError,
} from "./packetResidencyWorkingSet.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, triangles: number): GeometryResource {
  return { id, revision: 1,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
      1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1].slice(0, triangles * 3)) };
}

function packet() {
  return prepareRenderPacket({
    geometries: [geometry("fine", 3), geometry("middle", 2), geometry("coarse", 1)],
    textures: [{ id: "base", revision: 2, semantic: "baseColor" as const,
      width: 4, height: 4, data: new Uint8Array(64), mipmaps: [
        { width: 2, height: 2, data: new Uint8Array(16) },
        { width: 1, height: 1, data: new Uint8Array(4) },
      ] }],
    materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: "base" } }],
    instances: [{ id: "object", geometry: "fine", material: "material", transform: TRANSFORM,
      lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "middle", minProjectedDiameterPixels: 30, geometricError: 0.5 },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] } }],
  });
}

function projection(release = vi.fn()): ResidentPacketProjection {
  return { batches: [], released: false, partialLod: true,
    geometry: () => undefined, geometrySource: () => undefined,
    texture: () => undefined, textureSource: () => undefined, release };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture() {
  const load = vi.fn();
  const unregister = vi.fn(), dispose = vi.fn();
  const domain = { disposed: false, residentBytes: 0, retiredBytes: 0,
    registerPacket: vi.fn(), load, unregister, dispose } as unknown as PacketResidencyDomain;
  const ticket = Object.freeze({ requests: [] }) as unknown as PacketResidencyTicket;
  const prepared = packet(), batch = prepared.batches[0]!;
  return { domain, ticket, prepared, batch, load, unregister, dispose };
}

describe("createPacketResidencyWorkingSet", () => {
  it("plans visible LOD and mip demand and returns caller-owned projection", async () => {
    const f = fixture(), result = projection();
    f.load.mockResolvedValue(result);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);
    expect(working.requestRevision).toBe(0);

    await expect(working.load({ frame: 7,
      demands: [{ batchKey: f.batch.key, instanceId: "object", desiredLod: 1, priority: 9 }],
      textureMipLevels: new Map([["base", 1]]),
    })).resolves.toBe(result);

    expect(f.load).toHaveBeenCalledWith(f.ticket, { frame: 7, allowPartialLod: true,
      signal: expect.any(AbortSignal), requests: [
      { kind: "geometry", id: "middle", desiredLevel: 0, priority: 9, required: false },
      { kind: "geometry", id: "coarse", desiredLevel: 0, priority: 9, required: true },
      { kind: "texture", id: "base", desiredLevel: 1, priority: 9, required: true },
    ] });
    expect(result.release).not.toHaveBeenCalled();
    expect(working).toMatchObject({ disposed: false, pending: false, latestFrame: 7, requestRevision: 1 });
    working.dispose(); expect(result.release).not.toHaveBeenCalled();
  });

  it("compiles packet planning metadata once and ignores later caller collection mutation", async () => {
    const f = fixture(), result = projection(); f.load.mockResolvedValue(result);
    const mutable = { geometries: new Map(f.prepared.geometries),
      textures: [...f.prepared.textures], batches: [...f.prepared.batches] } as PreparedPacket;
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, mutable);
    mutable.geometries.clear();
    (mutable.textures as unknown as unknown[]).length = 0;
    (mutable.batches as unknown as unknown[]).length = 0;

    await expect(working.load({ frame: 1,
      demands: [{ batchKey: f.batch.key, instanceId: "object", desiredLod: 1 }],
    })).resolves.toBe(result);

    expect(f.load).toHaveBeenCalledWith(f.ticket, expect.objectContaining({ requests: [
      expect.objectContaining({ kind: "geometry", id: "middle", required: false }),
      expect.objectContaining({ kind: "geometry", id: "coarse", required: true }),
      expect.objectContaining({ kind: "texture", id: "base", required: true }),
    ] }));
  });

  it("publishes only the latest load and releases an older late projection", async () => {
    const f = fixture(), old = deferred<ResidentPacketProjection>();
    const latest = deferred<ResidentPacketProjection>();
    f.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);

    const first = working.load({ frame: 1, demands: [] });
    const second = working.load({ frame: 1, demands: [] });
    await expect(first).rejects.toMatchObject<PacketResidencyWorkingSetError>({ code: "superseded" });
    const current = projection(); latest.resolve(current);
    await expect(second).resolves.toBe(current);

    const stale = projection(); old.resolve(stale);
    await vi.waitFor(() => expect(stale.release).toHaveBeenCalledOnce());
    expect(current.release).not.toHaveBeenCalled();
  });

  it("aborts promptly and releases a projection that arrives afterward", async () => {
    const f = fixture(), late = deferred<ResidentPacketProjection>();
    f.load.mockReturnValue(late.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);
    const abort = new AbortController();

    const pending = working.load({ frame: 3, demands: [], signal: abort.signal });
    abort.abort("camera changed");
    await expect(pending).rejects.toMatchObject<PacketResidencyWorkingSetError>({
      code: "aborted", cause: "camera changed",
    });
    const discarded = projection(); late.resolve(discarded);
    await vi.waitFor(() => expect(discarded.release).toHaveBeenCalledOnce());
    expect(working.pending).toBe(false);
  });

  it("does not consume a frame or disturb work for an already-aborted signal", async () => {
    const f = fixture(), pending = deferred<ResidentPacketProjection>();
    f.load.mockReturnValue(pending.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);
    const abort = new AbortController(); abort.abort();

    await expect(working.load({ frame: 9, demands: [], signal: abort.signal }))
      .rejects.toMatchObject<PacketResidencyWorkingSetError>({ code: "aborted" });
    expect(f.load).not.toHaveBeenCalled(); expect(working.latestFrame).toBe(-1);

    const valid = working.load({ frame: 1, demands: [] });
    const accepted = projection(); pending.resolve(accepted);
    await expect(valid).resolves.toBe(accepted);
  });

  it("rejects stale or invalid plans without superseding valid pending work", async () => {
    const f = fixture(), pending = deferred<ResidentPacketProjection>();
    f.load.mockReturnValue(pending.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);
    const valid = working.load({ frame: 5, demands: [] });

    await expect(working.load({ frame: 4, demands: [] }))
      .rejects.toMatchObject<PacketResidencyWorkingSetError>({ code: "stale-frame" });
    await expect(working.load({ frame: 6, demands: [{ batchKey: "foreign" }] }))
      .rejects.toThrow("Unknown packet residency batch");
    expect(f.load).toHaveBeenCalledOnce();
    expect(working).toMatchObject({ latestFrame: 5, requestRevision: 1 });

    const accepted = projection(); pending.resolve(accepted);
    await expect(valid).resolves.toBe(accepted);
  });

  it("passes a foreign-ticket rejection through and clears pending state", async () => {
    const f = fixture();
    const foreign = new PacketResidencyLoadError("unbound-runtime", "ticket is foreign");
    f.load.mockRejectedValue(foreign);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);

    await expect(working.load({ frame: 1, demands: [] })).rejects.toBe(foreign);
    expect(working.pending).toBe(false);
    expect(f.unregister).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
  });

  it("dispose cancels delivery without owning the domain or ticket", async () => {
    const f = fixture(), late = deferred<ResidentPacketProjection>();
    f.load.mockReturnValue(late.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared);
    const pending = working.load({ frame: 1, demands: [] });

    working.dispose(); working.dispose();
    await expect(pending).rejects.toMatchObject<PacketResidencyWorkingSetError>({ code: "disposed" });
    await expect(working.load({ frame: 2, demands: [] }))
      .rejects.toMatchObject<PacketResidencyWorkingSetError>({ code: "disposed" });
    const discarded = projection(); late.resolve(discarded);
    await vi.waitFor(() => expect(discarded.release).toHaveBeenCalledOnce());
    expect(f.unregister).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled();
  });

  it("reports late cleanup failures without losing latest ownership", async () => {
    const f = fixture(), old = deferred<ResidentPacketProjection>();
    const current = deferred<ResidentPacketProjection>(), onDiscardError = vi.fn();
    f.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared,
      { onDiscardError });
    const superseded = working.load({ frame: 1, demands: [] });
    const latest = working.load({ frame: 2, demands: [] });
    await expect(superseded).rejects.toMatchObject({ code: "superseded" });
    const kept = projection(); current.resolve(kept); await expect(latest).resolves.toBe(kept);

    const cleanupError = new Error("lease release failed");
    old.resolve(projection(vi.fn(() => { throw cleanupError; })));
    await vi.waitFor(() => expect(onDiscardError).toHaveBeenCalledWith(cleanupError));
    expect(working.lastDiscardError).toBe(cleanupError);
    expect(kept.release).not.toHaveBeenCalled();
  });

  it("reports an unexpected domain failure that arrives after prompt cancellation", async () => {
    const f = fixture(), late = deferred<ResidentPacketProjection>(), onDiscardError = vi.fn();
    f.load.mockReturnValue(late.promise);
    const working = createPacketResidencyWorkingSet(f.domain, f.ticket, f.prepared,
      { onDiscardError });
    const abort = new AbortController();
    const pending = working.load({ frame: 1, demands: [], signal: abort.signal });
    abort.abort("camera moved");
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    const cleanupFailure = new Error("candidate release failed");
    late.reject(cleanupFailure);
    await vi.waitFor(() => expect(onDiscardError).toHaveBeenCalledWith(cleanupFailure));
    expect(working.lastDiscardError).toBe(cleanupFailure);
  });
});
