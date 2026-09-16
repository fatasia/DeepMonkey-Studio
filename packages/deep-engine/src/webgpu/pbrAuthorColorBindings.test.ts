import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrAuthorColorBindings } from "./pbrAuthorColorBindings.js";

function fixture() {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  const buffer = { destroy: vi.fn() }, release = vi.fn();
  const device = { createBuffer: vi.fn(() => buffer), createBindGroup: vi.fn(() => ({})), queue: { writeBuffer: vi.fn() } };
  const session = { device, own: (value: unknown) => value, release } as unknown as DeviceSession;
  return { device, session, release, buffer };
}
afterEach(() => vi.unstubAllGlobals());
describe("author output uniform ownership", () => {
  it("uploads immutable parameter copies only on changes and retains a stable binding", () => {
    const f = fixture(), target = new PbrAuthorColorBindings(f.session, {} as GPUBindGroupLayout);
    const binding = target.binding, effects = { vignette: { darkness: 1.2 } };
    target.update(effects); const uploaded = f.device.queue.writeBuffer.mock.calls.at(-1)![2] as Float32Array;
    effects.vignette.darkness = 2;
    expect(uploaded[3]).toBeCloseTo(1.2);
    target.update({ vignette: { darkness: 1.2 } }); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    target.update({}); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(3);
    expect(target.binding).toBe(binding); expect(f.device.createBindGroup).toHaveBeenCalledOnce();
    target.dispose(); target.dispose(); expect(f.release).toHaveBeenCalledExactlyOnceWith(f.buffer);
    expect(() => target.update({})).toThrow("disposed");
  });
  it("releases allocation if binding creation fails", () => {
    const f = fixture(); f.device.createBindGroup.mockImplementation(() => { throw new Error("binding rejected"); });
    expect(() => new PbrAuthorColorBindings(f.session, {} as GPUBindGroupLayout)).toThrow("binding rejected");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(f.buffer);
  });
  it("clears prior author effects when returning to legacy and rejects invalid updates before upload", () => {
    const f = fixture(), target = new PbrAuthorColorBindings(f.session, {} as GPUBindGroupLayout);
    target.update({ vignette: { darkness: 3 } }); target.update(undefined);
    const data = f.device.queue.writeBuffer.mock.calls.at(-1)![2] as Float32Array;
    expect(Array.from(data)).toEqual(new Array(8).fill(0));
    expect(() => target.update({ vignette: { darkness: Infinity } })).toThrow();
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(3); target.dispose();
  });
  it("does not advance cached settings after upload failure", () => {
    const f = fixture(), target = new PbrAuthorColorBindings(f.session, {} as GPUBindGroupLayout);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("upload failed"); });
    expect(() => target.update({})).toThrow("upload failed");
    target.update({}); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(3); target.dispose();
  });
});
