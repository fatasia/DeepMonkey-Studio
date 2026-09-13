import { describe, expect, it, vi } from "vitest";
import type { PreparedPacket } from "../renderPacketTypes.js";
import type { PacketResidencyDomain, PacketResidencyTicket } from "./packetResidencyDomain.js";
import {
  createPbrResidencyStream,
  type PbrResidencyFrameTarget,
} from "./pbrResidencyStream.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";

const PACKET = Object.freeze({ geometries: new Map(), textures: Object.freeze([]),
  batches: Object.freeze([]) }) as PreparedPacket;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function projection(releaseFailure?: Error): ResidentPacketProjection {
  let released = false;
  return { batches: [], partialLod: true, get released() { return released; },
    geometry: () => undefined, geometrySource: () => undefined,
    texture: () => undefined, textureSource: () => undefined,
    release: vi.fn(() => {
      if (releaseFailure) throw releaseFailure;
      released = true;
    }) };
}

function fixture() {
  const load = vi.fn();
  const domain = { disposed: false, residentBytes: 0, retiredBytes: 0,
    registerPacket: vi.fn(), load, unregister: vi.fn(), dispose: vi.fn(),
  } as unknown as PacketResidencyDomain;
  const ticket = Object.freeze({ requests: [] }) as unknown as PacketResidencyTicket;
  let pending: ResidentPacketProjection | undefined;
  const target: PbrResidencyFrameTarget & { pending?: ResidentPacketProjection } = {
    async stageResidentPacketValidated(value, signal) {
      if (signal?.aborted) throw signal.reason;
      pending = value; target.pending = value;
    },
    cancelResidentPacketStage: vi.fn(() => {
      const value = pending; pending = undefined; target.pending = undefined;
      if (value && !value.released) value.release();
    }),
  };
  vi.spyOn(target, "stageResidentPacketValidated");
  return { domain, ticket, target, load };
}

describe("createPbrResidencyStream", () => {
  it("loads a partial closure and transfers it to deferred frame-boundary staging", async () => {
    const f = fixture(), resident = projection(); f.load.mockResolvedValue(resident);
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);

    await expect(stream.stage({ frame: 4, demands: [] })).resolves.toEqual({ frame: 4 });

    expect(f.load).toHaveBeenCalledWith(f.ticket,
      { frame: 4, requests: [], allowPartialLod: true, signal: expect.any(AbortSignal) });
    expect(f.target.stageResidentPacketValidated).toHaveBeenCalledWith(resident, expect.any(AbortSignal));
    expect(f.target.pending).toBe(resident);
    expect(resident.release).not.toHaveBeenCalled();
    expect(stream).toMatchObject({ disposed: false, pending: false, latestFrame: 4 });
  });

  it("revokes a completed unpublished candidate as soon as a newer request is accepted", async () => {
    const f = fixture(), first = projection(), next = deferred<ResidentPacketProjection>();
    f.load.mockResolvedValueOnce(first).mockReturnValueOnce(next.promise);
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);
    await stream.stage({ frame: 1, demands: [] });

    const latest = stream.stage({ frame: 2, demands: [] });
    expect(first.release).toHaveBeenCalledOnce();
    expect(f.target.pending).toBeUndefined();
    const second = projection(); next.resolve(second);
    await expect(latest).resolves.toEqual({ frame: 2 });
    expect(f.target.pending).toBe(second);
  });

  it("does not disturb a valid candidate for an invalid same-frame request", async () => {
    const f = fixture(), resident = projection(); f.load.mockResolvedValue(resident);
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);
    await stream.stage({ frame: 3, demands: [] });
    const cancellationCount = vi.mocked(f.target.cancelResidentPacketStage).mock.calls.length;

    await expect(stream.stage({ frame: 3, demands: [{ batchKey: "foreign" }] }))
      .rejects.toThrow("Unknown packet residency batch");

    expect(f.target.cancelResidentPacketStage).toHaveBeenCalledTimes(cancellationCount);
    expect(f.target.pending).toBe(resident);
    expect(resident.release).not.toHaveBeenCalled();
  });

  it("aborts in-flight target validation and lets only the latest stage resolve", async () => {
    const f = fixture(), first = projection(), second = projection();
    f.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const validating = deferred<void>();
    vi.mocked(f.target.stageResidentPacketValidated)
      .mockImplementationOnce(async (value, signal) => {
        f.target.pending = value;
        signal?.addEventListener("abort", () => {
          if (!value.released) value.release();
          f.target.pending = undefined;
          validating.reject(signal.reason);
        }, { once: true });
        return validating.promise;
      })
      .mockImplementationOnce(async value => { f.target.pending = value; });
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);
    const stale = stream.stage({ frame: 8, demands: [] });
    await vi.waitFor(() => expect(f.target.stageResidentPacketValidated).toHaveBeenCalledOnce());

    const latest = stream.stage({ frame: 8, demands: [] });
    await expect(stale).rejects.toMatchObject({ code: "superseded" });
    await expect(latest).resolves.toEqual({ frame: 8 });
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).not.toHaveBeenCalled();
  });

  it("propagates external abort into the domain load signal", async () => {
    const f = fixture(), loading = deferred<ResidentPacketProjection>();
    f.load.mockReturnValue(loading.promise);
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);
    const abort = new AbortController();
    const pending = stream.stage({ frame: 5, demands: [], signal: abort.signal });
    const domainSignal = f.load.mock.calls[0]![1].signal as AbortSignal;

    expect(domainSignal.aborted).toBe(false);
    abort.abort("camera moved");
    await expect(pending).rejects.toMatchObject({ code: "aborted", cause: "camera moved" });
    expect(domainSignal.aborted).toBe(true);
    const late = projection(); loading.resolve(late);
    await vi.waitFor(() => expect(late.release).toHaveBeenCalledOnce());
    expect(f.target.stageResidentPacketValidated).not.toHaveBeenCalled();
  });

  it("releases an unowned projection and aggregates target and lease rollback failures", async () => {
    const f = fixture(), releaseFailure = new Error("lease cleanup failed");
    const resident = projection(releaseFailure), stageFailure = new Error("validation failed");
    const targetCleanupFailure = new Error("target cleanup failed");
    f.load.mockResolvedValue(resident);
    vi.mocked(f.target.stageResidentPacketValidated).mockRejectedValue(stageFailure);
    vi.mocked(f.target.cancelResidentPacketStage)
      .mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw targetCleanupFailure; });
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);

    const error = await stream.stage({ frame: 1, demands: [] }).catch(value => value);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([stageFailure, targetCleanupFailure, releaseFailure]);
    expect(resident.release).toHaveBeenCalledOnce();
    expect(stream.pending).toBe(false);
  });

  it("disposes its pending candidate and work without owning the domain or ticket", async () => {
    const f = fixture(), resident = projection(); f.load.mockResolvedValue(resident);
    const stream = createPbrResidencyStream(f.domain, f.ticket, PACKET, f.target);
    await stream.stage({ frame: 1, demands: [] });

    stream.dispose(); stream.dispose();

    expect(resident.release).toHaveBeenCalledOnce();
    expect(f.domain.unregister).not.toHaveBeenCalled();
    expect(f.domain.dispose).not.toHaveBeenCalled();
    await expect(stream.stage({ frame: 2, demands: [] })).rejects.toMatchObject({ code: "disposed" });
  });
});
