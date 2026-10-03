import { describe, expect, it } from "vitest";
import { browserMaterialExtensions } from "./renderPacketBrowserMaterial.js";

describe("browser runtime package advancedParameters", () => {
  it("accepts the JSON-friendly shape (omitted attenuationDistance = no attenuation)", () => {
    const advanced = { sheen: { color: [0.5, 0.5, 0.5], roughness: 0.4 }, iridescence: { factor: 1, ior: 1.3, thickness: 400 },
      volume: { thickness: 0.5, attenuationColor: [0.5, 1, 0.5] } };
    expect(browserMaterialExtensions({ advancedParameters: advanced }, "$.materials[0]").advancedParameters).toEqual(advanced);
    expect(JSON.parse(JSON.stringify(advanced))).toEqual(advanced);
  });

  it("fails closed on unknown keys, non-finite numbers and out-of-range values", () => {
    const parse = (advancedParameters: unknown) => () => browserMaterialExtensions({ advancedParameters }, "$.materials[0]");
    expect(parse({ unknown: {} })).toThrow();
    expect(parse({ sheen: { color: [2, 0, 0], roughness: 0.4 } })).toThrow();
    expect(parse({ volume: { thickness: 1, attenuationColor: [1, 1, 1], attenuationDistance: null } })).toThrow();
    expect(parse({ iridescence: { factor: 1, ior: 0.5, thickness: 100 } })).toThrow();
  });

  it("is absent by default", () => {
    expect(browserMaterialExtensions({}, "$.materials[0]")).toEqual({});
  });
});