import { describe, expect, it, vi } from "vitest";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import {
  ResidentPacketPublisher,
  type ResidentPacketCandidate,
} from "./residentPacketPublisher.js";

function projection(name: string, releaseError?: Error): ResidentPacketProjection & {
  readonly name: string;
  readonly releaseMock: ReturnType<typeof vi.fn>;
} {
  let released = false;
  const releaseMock = vi.fn(() => {
    if (released) return;
    released = true;
    if (releaseError) throw releaseError;
  });
  return {
    name,
    batches: [],
    get released() { return released; },
    geometry: () => undefined,
    geometrySource: () => undefined,
    texture: () => undefined,
    textureSource: () => undefined,
    release: releaseMock,
    releaseMock,
  };
}

describe("ResidentPacketPublisher", () => {
  it("stages one candidate and publishes it only at the explicit frame boundary", () => {
    const publisher = new ResidentPacketPublisher();
    const next = projection("next");
    const candidate = publisher.stage(next);

    expect(publisher.active).toBeUndefined();
    expect(publisher.pending).toBe(candidate);
    expect(candidate.generation).toBe(1);

    expect(publisher.commit(candidate)).toBe(next);
    expect(publisher.active).toBe(next);
    expect(publisher.pending).toBeUndefined();
    expect(next.releaseMock).not.toHaveBeenCalled();
  });

  it("supersedes and releases an older pending candidate", () => {
    const publisher = new ResidentPacketPublisher();
    const first = projection("first"), second = projection("second");
    const stale = publisher.stage(first);
    const current = publisher.stage(second);

    expect(first.releaseMock).toHaveBeenCalledOnce();
    expect(publisher.pending).toBe(current);
    expect(() => publisher.commit(stale)).toThrow("stale or foreign");
    expect(publisher.active).toBeUndefined();
    expect(publisher.pending).toBe(current);
    publisher.commit(current);
    expect(publisher.active).toBe(second);
  });

  it("rejects cloned and foreign tokens without touching active or pending state", () => {
    const publisher = new ResidentPacketPublisher();
    const active = projection("active"), next = projection("next");
    publisher.commit(publisher.stage(active));
    const token = publisher.stage(next);
    const clone = { ...token } as ResidentPacketCandidate;
    const foreign = new ResidentPacketPublisher().stage(projection("foreign"));

    expect(() => publisher.commit(clone)).toThrow("stale or foreign");
    expect(() => publisher.commit(foreign)).toThrow("stale or foreign");
    expect(publisher.active).toBe(active);
    expect(publisher.pending).toBe(token);
    expect(active.releaseMock).not.toHaveBeenCalled();
    expect(next.releaseMock).not.toHaveBeenCalled();
  });

  it("installs the new active projection before reporting old-active release failure", () => {
    const failure = new Error("old release failed");
    const publisher = new ResidentPacketPublisher();
    const old = projection("old", failure), next = projection("next");
    publisher.commit(publisher.stage(old));
    const candidate = publisher.stage(next);

    expect(() => publisher.commit(candidate)).toThrow(AggregateError);
    expect(publisher.active).toBe(next);
    expect(publisher.pending).toBeUndefined();
    expect(old.releaseMock).toHaveBeenCalledOnce();
    expect(next.releaseMock).not.toHaveBeenCalled();
    expect(() => publisher.commit(candidate)).toThrow("stale or foreign");
  });

  it.each(["cancel", "fail"] as const)("%s releases only the pending candidate", operation => {
    const publisher = new ResidentPacketPublisher();
    const active = projection("active"), next = projection("next");
    publisher.commit(publisher.stage(active));
    const candidate = publisher.stage(next);

    publisher[operation](candidate);

    expect(publisher.active).toBe(active);
    expect(publisher.pending).toBeUndefined();
    expect(active.releaseMock).not.toHaveBeenCalled();
    expect(next.releaseMock).toHaveBeenCalledOnce();
    expect(() => publisher[operation](candidate)).toThrow("stale or foreign");
  });

  it("terminates cancellation state even when candidate release throws", () => {
    const failure = new Error("candidate release failed");
    const publisher = new ResidentPacketPublisher();
    const candidate = publisher.stage(projection("candidate", failure));

    expect(() => publisher.cancel(candidate)).toThrow(AggregateError);
    expect(publisher.pending).toBeUndefined();
    expect(publisher.active).toBeUndefined();
    expect(() => publisher.commit(candidate)).toThrow("stale or foreign");
  });

  it("rolls back the incoming candidate if superseded pending cleanup fails", () => {
    const publisher = new ResidentPacketPublisher();
    const broken = projection("broken", new Error("retire failed"));
    const incoming = projection("incoming");
    publisher.stage(broken);

    expect(() => publisher.stage(incoming)).toThrow(AggregateError);
    expect(broken.releaseMock).toHaveBeenCalledOnce();
    expect(incoming.releaseMock).toHaveBeenCalledOnce();
    expect(publisher.pending).toBeUndefined();
    expect(publisher.active).toBeUndefined();
  });

  it("disposes active and pending best effort and remains terminal after failures", () => {
    const publisher = new ResidentPacketPublisher();
    const active = projection("active", new Error("active release failed"));
    const pending = projection("pending", new Error("pending release failed"));
    publisher.commit(publisher.stage(active));
    publisher.stage(pending);

    expect(() => publisher.dispose()).toThrow(AggregateError);
    expect(active.releaseMock).toHaveBeenCalledOnce();
    expect(pending.releaseMock).toHaveBeenCalledOnce();
    expect(publisher.disposed).toBe(true);
    expect(publisher.active).toBeUndefined();
    expect(publisher.pending).toBeUndefined();
    expect(() => publisher.stage(projection("late"))).toThrow("disposed");
    expect(() => publisher.dispose()).not.toThrow();
  });

  it("rejects released or duplicate projections before changing ownership", () => {
    const publisher = new ResidentPacketPublisher();
    const active = projection("active");
    publisher.commit(publisher.stage(active));

    expect(() => publisher.stage(active)).toThrow("already owned");
    const released = projection("released"); released.release();
    expect(() => publisher.stage(released)).toThrow("already released");
    expect(publisher.active).toBe(active);
  });
});
