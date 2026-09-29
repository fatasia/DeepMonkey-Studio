import { describe, expect, it } from "vitest";
import { snapshotRendererOptions } from "./deepWebGpuOptions.js";
import { resolveVirtualTextureOptions } from "../virtualTextures/virtualTextureOptions.js";

/** F4 尾巴切片:opt-in 能力经快照白名单暴露给宿主的两键合同。 */
describe("snapshotRendererOptions opt-in keys", () => {
  describe("temporalUpscale (features key, F4 super-resolution)", () => {
    it("passes the explicit opt-in through the features snapshot", () => {
      const snapshot = snapshotRendererOptions({ features: { temporalUpscale: true } });
      expect(snapshot.features?.temporalUpscale).toBe(true);
    });
    it("keeps an explicit opt-out false and omits the whole key when absent", () => {
      expect(snapshotRendererOptions({ features: { temporalUpscale: false } }).features?.temporalUpscale).toBe(false);
      // 缺省不进快照(resolutionScalePolicy 先例);默认值解析发生在渲染器构造期。
      expect("features" in snapshotRendererOptions({})).toBe(false);
    });
    it("fails closed on a non-boolean feature value", () => {
      expect(() => snapshotRendererOptions({ features: { temporalUpscale: "yes" as never } }))
        .toThrow("PBR feature temporalUpscale must be boolean.");
    });
  });

  describe("virtualTextures key (F3 wiring)", () => {
    it("omits the key from the snapshot when absent", () => {
      expect("virtualTextures" in snapshotRendererOptions({})).toBe(false);
    });
    it("passes an explicit configuration through as a frozen snapshot", () => {
      const snapshot = snapshotRendererOptions({ virtualTextures: { enabled: true, maxResidentBytes: 1024 } });
      expect(snapshot.virtualTextures).toEqual({ enabled: true, maxResidentBytes: 1024 });
      expect(Object.isFrozen(snapshot.virtualTextures)).toBe(true);
    });
    it("fails closed when the value is not an object instead of spreading it into an empty one", () => {
      for (const invalid of [5, null, "on", [], true]) {
        expect(() => snapshotRendererOptions({ virtualTextures: invalid as never }))
          .toThrow("Deep WebGPU virtualTextures option must be an object.");
      }
    });
    it("keeps the resolve-layer fail-closed contract for field-invalid configurations", () => {
      // 快照边界只守结构;字段级非法(启用但缺预算)由解析层 fail-closed 回退,
      // 渲染循环存活(不抛、不静默),快照值原样透传可复现。
      const snapshot = snapshotRendererOptions({ virtualTextures: { enabled: true } });
      expect(resolveVirtualTextureOptions(snapshot.virtualTextures!))
        .toEqual({ enabled: false, reason: "virtual-texture:max-resident-bytes-required-when-enabled" });
    });
  });
});
