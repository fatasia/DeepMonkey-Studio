import { expect, it, vi } from "vitest";
import { validateRenderPacketAsync, type PacketValidationWorker } from "./packetValidationAsync.js";
import type { RenderPacket } from "./renderPacket.js";

const empty: RenderPacket = { geometries: [], materials: [], instances: [] };
function worker() {
  return { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() } satisfies PacketValidationWorker as
    PacketValidationWorker & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
}
it("validates locally without a browser worker and rejects malformed input", async () => {
  await expect(validateRenderPacketAsync(empty)).resolves.toBeUndefined();
  await expect(validateRenderPacketAsync({ ...empty, textures: null as unknown as RenderPacket["textures"] })).rejects.toThrow();
});
it("accepts only a completed validation, without returning copied resource planes", async () => {
  const host = worker();
  const task = validateRenderPacketAsync(empty, {}, undefined, () => host);
  expect(host.postMessage).toHaveBeenCalledWith({ packet: empty, options: {}, validateOnly: true });
  host.onmessage!({ data: { validated: true } });
  await expect(task).resolves.toBeUndefined();
  expect(host.terminate).toHaveBeenCalledOnce();
  expect(host.onmessage).toBeNull();
});
it("cancellation retires the validation worker and ignores a queued result", async () => {
  const host = worker(), signal = new AbortController();
  const task = validateRenderPacketAsync(empty, {}, signal.signal, () => host);
  const queued = host.onmessage!;
  signal.abort(); queued({ data: { validated: true } });
  await expect(task).rejects.toMatchObject({ name: "AbortError" });
  expect(host.terminate).toHaveBeenCalledOnce();
});
it.each([{ error: "invalid geometry" }, {}, { validated: false }])("rejects invalid worker admission %j", async data => {
  const host = worker();
  const task = validateRenderPacketAsync(empty, {}, undefined, () => host);
  host.onmessage!({ data });
  await expect(task).rejects.toThrow();
  expect(host.terminate).toHaveBeenCalledOnce();
});
