import { describe, expect, it, vi } from "vitest";
import { GpuResidentOwner } from "./gpuResidentLease.js";

interface Handle { readonly id: string }

describe("GpuResidentOwner", () => {
  it("releases uploader ownership immediately when retired without leases", () => {
    const resource = { id: "texture" }, release = vi.fn();
    const owner = new GpuResidentOwner(resource, release);

    owner.retire(); owner.retire();

    expect(owner.retired).toBe(true);
    expect(owner.activeLeaseCount).toBe(0);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(resource);
  });

  it("keeps the resource until multiple leases release out of order exactly once", () => {
    const resource: Handle = { id: "geometry" }, release = vi.fn();
    const owner = new GpuResidentOwner(resource, release);
    const first = owner.acquire(), second = owner.acquire(), third = owner.acquire();

    expect(first.resource).toBe(resource);
    expect(second.resource).toBe(resource);
    expect(owner.activeLeaseCount).toBe(3);
    second.release(); second.release();
    expect(owner.activeLeaseCount).toBe(2);
    expect(release).not.toHaveBeenCalled();
    owner.retire(); third.release();
    expect(release).not.toHaveBeenCalled();
    first.release(); first.release();

    expect(owner.activeLeaseCount).toBe(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects new leases after retirement", () => {
    const owner = new GpuResidentOwner({ id: "buffer" }, vi.fn());
    const lease = owner.acquire(); lease.release(); owner.retire();

    expect(() => owner.acquire()).toThrow("retired GPU resident resource");
    expect(owner.activeLeaseCount).toBe(0);
  });

  it("stays terminated when the underlying release throws", () => {
    const failure = new Error("device release failed");
    const release = vi.fn(() => { throw failure; });
    const owner = new GpuResidentOwner({ id: "buffer" }, release);
    const lease = owner.acquire(); owner.retire();

    expect(() => lease.release()).toThrow(failure);
    expect(owner.retired).toBe(true);
    expect(owner.activeLeaseCount).toBe(0);
    expect(() => lease.release()).not.toThrow();
    expect(() => owner.retire()).not.toThrow();
    expect(release).toHaveBeenCalledOnce();
    expect(() => owner.acquire()).toThrow("retired GPU resident resource");
  });
});
