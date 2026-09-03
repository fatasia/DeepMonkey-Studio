import { describe, expect, it } from "vitest";
import { normalizeMaterialDataPatch } from "./materialDataPatch";

describe("normalizeMaterialDataPatch", () => {
  it("accepts finite scalar PBR and UV values", () => {
    expect(normalizeMaterialDataPatch({
      color: "#35a7ff",
      metalness: 0.8,
      roughness: 0.25,
      textureRepeatX: 2,
      hue: 45,
      saturation: 0.3,
      brightness: -0.2,
      contrast: 0.4,
      doubleSided: true,
    })).toEqual({
      color: "#35a7ff",
      metalness: 0.8,
      roughness: 0.25,
      textureRepeatX: 2,
      hue: 45,
      saturation: 0.3,
      brightness: -0.2,
      contrast: 0.4,
      doubleSided: true,
    });
  });

  it("rejects unsupported resources, invalid ranges and accessors", () => {
    expect(() => normalizeMaterialDataPatch({ baseColorMapUrl: "https://untrusted.test/map.png" })).toThrow("不支持参数");
    expect(() => normalizeMaterialDataPatch({ roughness: 2 })).toThrow("0–1");
    expect(() => normalizeMaterialDataPatch({ hue: 181 })).toThrow("-180–180");
    expect(() => normalizeMaterialDataPatch({ contrast: -1.1 })).toThrow("-1–1");
    expect(() => normalizeMaterialDataPatch(Object.defineProperty({}, "roughness", { get: () => 0.5, enumerable: true }))).toThrow("不能使用访问器");
  });
});
