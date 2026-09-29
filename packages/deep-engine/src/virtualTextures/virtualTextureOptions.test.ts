import { describe, expect, it } from "vitest";
import { resolveVirtualTextureOptions } from "./virtualTextureOptions.js";

/**
 * F3 opt-in 契约回归:默认(不带 enabled)零行为变化;启用但配置非法一律
 * fail-closed 回 enabled:false + 可定位原因,绝不半启用。
 */
describe("resolveVirtualTextureOptions", () => {
  it("默认关闭:无参与空对象都返回显式 not-enabled,零行为变化", () => {
    expect(resolveVirtualTextureOptions()).toEqual({ enabled: false, reason: "virtual-texture:not-enabled" });
    expect(resolveVirtualTextureOptions({})).toEqual({ enabled: false, reason: "virtual-texture:not-enabled" });
    expect(resolveVirtualTextureOptions({ enabled: false })).toEqual({ enabled: false,
      reason: "virtual-texture:not-enabled" });
  });

  it("启用但缺 maxResidentBytes / 非法数值 → fail-closed,不半启用", () => {
    expect(resolveVirtualTextureOptions({ enabled: true })).toEqual({ enabled: false,
      reason: "virtual-texture:max-resident-bytes-required-when-enabled" });
    expect(resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 0 }).enabled).toBe(false);
    expect(resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 1024, tileEdgeTexels: 96 }).reason)
      .toBe("virtual-texture:tile-edge-must-be-power-of-two-1..4096");
    expect(resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 1024, maxPages: 0 }).enabled).toBe(false);
    expect(resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 1024,
      maxUploadPagesPerFrame: 0 }).enabled).toBe(false);
    expect(resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 1024,
      minResidentFrames: -1 }).enabled).toBe(false);
    expect(resolveVirtualTextureOptions([1, 2] as unknown as Parameters<typeof resolveVirtualTextureOptions>[0])
      .reason).toBe("virtual-texture:options-not-an-object");
  });

  it("合法配置回显并补齐缺省(tile 128 / 上传 16 / dwell 0)", () => {
    expect(resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 8 * 1024 * 1024 })).toEqual({
      enabled: true, maxResidentBytes: 8 * 1024 * 1024,
      spec: { tileEdgeTexels: 128, bytesPerTexel: 4 },
      maxUploadPagesPerFrame: 16, minResidentFrames: 0,
    });
    const explicit = resolveVirtualTextureOptions({ enabled: true, maxResidentBytes: 1024, maxPages: 4,
      tileEdgeTexels: 64, maxUploadPagesPerFrame: 2, minResidentFrames: 30 });
    expect(explicit).toMatchObject({ enabled: true, maxPages: 4, maxUploadPagesPerFrame: 2,
      minResidentFrames: 30 });
    if (explicit.enabled) expect(explicit.spec).toEqual({ tileEdgeTexels: 64, bytesPerTexel: 4 });
  });
});
