import { describe, expect, it, vi } from "vitest";
import { PacketBuffers } from "./packetBuffers.js";

/** 裸 this 拆除夹具:与 PacketBuffers.dispose 的调用面逐字段对齐(空场景,无 GPU 依赖)。 */
function disposalFixture() {
  const fixture = {
    disposed: false, generation: 0, publishedScene: true,
    geometries: new Map(), geometryBounds: new Map(), batches: new Map(), motionHistory: new Map(),
    textureLookup: {}, materialEffects: { stages: [] },
    deformationReadiness: Promise.resolve(),
    lod: undefined, shadowLod: undefined,
    validation: { cancel: vi.fn() }, deformation: { dispose: vi.fn() },
    resident: { cancel: vi.fn(), detachActive: vi.fn(() => undefined) },
    materials: { release: vi.fn() }, culling: { dispose: vi.fn() },
    lodInputs: { clear: vi.fn() }, textureArrays: undefined, textures: { dispose: vi.fn() },
    session: { release: vi.fn() },
  };
  // PacketBuffers.dispose 经私有方法 residentContext() 取释放上下文;裸 this 夹具补齐。
  (fixture as Record<string, unknown>).residentContext = () => ({
    session: fixture.session, materials: fixture.materials, geometries: fixture.geometries, batches: fixture.batches });
  return fixture;
}

// A2-刀1:settled promise 的 resolved 值(延迟注入的变形 Pipelines 图)在 promise
// 可达期间被 V8 持有;dispose 必须断开,disposed 后所有入口在 beginMutation 抛错,
// 不会再 await 该 promise。
describe("packet buffers disposal", () => {
  it("detaches the deferred deformation pipeline promise and clears CPU snapshots", () => {
    const packets = disposalFixture();
    PacketBuffers.prototype.dispose.call(packets as never);
    expect(packets.deformationReadiness).toBeUndefined();
    expect(packets.geometries.size).toBe(0);
    expect(packets.batches.size).toBe(0);
    expect(packets.motionHistory.size).toBe(0);
    expect(packets.validation.cancel).toHaveBeenCalledTimes(1);
    expect(packets.deformation.dispose).toHaveBeenCalledTimes(1);
    expect(packets.textures.dispose).toHaveBeenCalledTimes(1);
    expect(packets.lodInputs.clear).toHaveBeenCalledTimes(1);
  });

  it("stays idempotent on repeated disposal", () => {
    const packets = disposalFixture();
    PacketBuffers.prototype.dispose.call(packets as never);
    PacketBuffers.prototype.dispose.call(packets as never);
    expect(packets.validation.cancel).toHaveBeenCalledTimes(1);
  });
});
