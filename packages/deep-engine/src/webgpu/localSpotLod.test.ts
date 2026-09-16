import { describe, expect, it, vi } from "vitest";
import { LocalSpotLod } from "./localSpotLod.js";
import type { PacketBuffers } from "./packetBuffers.js";
import type { PacketLodResources } from "./packetLodResources.js";
import type { SelectedLocalSpotShadow } from "./localSpotShadowSelection.js";
const spot = (key: string) => ({ light: { shadow: { key }, positionWorld: [0, 0, 3], directionWorld: [0, 0, -1], range: 10, outerConeCos: .9 },
  tile: { size: 508 }, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } as unknown as SelectedLocalSpotShadow);
const resource = () => ({ cancelFrame: vi.fn(), failFrame: vi.fn(), dispose: vi.fn(), commitFrame: vi.fn() });
const stats = { inputObjects: 1, selectionBatches: 1, indirectDraws: 1, historyReset: false, authorFrustumPasses: 1, authorFrustumDispatches: 2 };
describe("independent spot LOD transaction", () => {
  it("disposes unpublished views when a later view fails and preserves committed views on retry", () => {
    const owner = new LocalSpotLod(), first = resource(), next = resource(), encoder = {} as GPUCommandEncoder;
    const encode = vi.fn().mockReturnValueOnce({ resources: first, stats }).mockImplementationOnce(() => { throw Error("second spot failed"); });
    const packets = { encodeIndependentLod: encode } as unknown as PacketBuffers;
    expect(() => owner.encode(encoder, packets, [spot("a"), spot("b")])).toThrow("second spot failed");
    expect(first.dispose).toHaveBeenCalledOnce(); expect(owner.view(spot("a"))).toBeNull();
    encode.mockReturnValueOnce({ resources: next, stats }); owner.encode(encoder, packets, [spot("a")]); owner.commit();
    expect(next.commitFrame).toHaveBeenCalledOnce();
    encode.mockReturnValueOnce({ resources: next, stats }).mockImplementationOnce(() => { throw Error("later failed"); });
    expect(() => owner.encode(encoder, packets, [spot("a"), spot("b")])).toThrow("later failed");
    expect(next.cancelFrame).toHaveBeenCalledOnce(); expect(next.dispose).not.toHaveBeenCalled();
    expect(encode.mock.calls.at(-2)![2]).toBe(next); owner.dispose(); expect(next.dispose).toHaveBeenCalledOnce();
  });
  it("retires removed lights only on commit and discards a rejected new view", () => {
    const owner = new LocalSpotLod(), a = resource(), b = resource(), encoder = {} as GPUCommandEncoder;
    const encode = vi.fn().mockReturnValueOnce({ resources: a, stats }).mockReturnValueOnce({ resources: b, stats });
    const packets = { encodeIndependentLod: encode } as unknown as PacketBuffers;
    owner.encode(encoder, packets, [spot("a")]); owner.commit();
    expect(owner.encode(encoder, packets, [spot("b")])).toEqual({ authorFrustumPasses: 1, authorFrustumDispatches: 2 });
    owner.fail(); expect(b.dispose).toHaveBeenCalledOnce(); expect(a.dispose).not.toHaveBeenCalled();
    expect(owner.view(spot("a"))).toBe(a as unknown as PacketLodResources);
    expect(owner.encode(encoder, packets, [])).toEqual({ authorFrustumPasses: 0, authorFrustumDispatches: 0 });
    expect(a.dispose).not.toHaveBeenCalled(); owner.commit(); expect(a.dispose).toHaveBeenCalledOnce(); owner.dispose();
  });
});
