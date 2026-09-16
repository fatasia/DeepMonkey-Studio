import { describe, expect, it } from "vitest";
import { deformationPacket } from "../renderPacketDeformation.testUtils.js";
import { materializeRuntimeRenderPacket, normalizeRuntimeRenderPacket, serializeBrowserRenderPacket, validateRuntimeRenderPacket } from "./renderPacket.js";
import { buildDeepRuntimePackage } from "./builder.js";

describe("Browser deformation packet JSON", () => {
  it("roundtrips owned skin tangent arrays and rejects malformed tangent sizes", () => {
    const original = deformationPacket("skin"), source = original.deformation.sources[0]!;
    const packet = { ...original, deformation: { ...original.deformation, sources: [{ ...source,
      skinning: { ...source.skinning!, tangents: original.geometries[0]!.tangents!.slice() } }] } };
    const json = JSON.parse(serializeBrowserRenderPacket(packet));
    const decoded = materializeRuntimeRenderPacket(json, "$").deformation!.sources[0]!.skinning!.tangents!;
    expect(decoded).toBeInstanceOf(Float32Array); expect(decoded).toEqual(original.geometries[0]!.tangents);
    expect(decoded).not.toBe(packet.deformation.sources[0]!.skinning.tangents);
    json.deformation.sources[0].skinning.tangents = [1, 0, 0, 1];
    expect(() => materializeRuntimeRenderPacket(json, "$")).toThrow("tangent");
  });
  it.each(["morph", "skin", "morph-skin"] as const)("roundtrips all %s typed streams and poses", kind => {
    const source = deformationPacket(kind), serialized = serializeBrowserRenderPacket(source);
    const result = materializeRuntimeRenderPacket(JSON.parse(serialized), "$");
    expect(result.deformation).toEqual(source.deformation); expect(result.instances[0]!.pose).toBe("pose");
    if (source.deformation.sources[0]!.skinning) expect(result.deformation!.sources[0]!.skinning!.joints).toBeInstanceOf(Uint16Array);
    if (source.deformation.sources[0]!.morph) expect(result.deformation!.sources[0]!.morph!.positions).toBeInstanceOf(Float32Array);
  });
  it("preserves 32-bit joint arrays and supports historical raw numeric-key arrays", () => {
    const source = deformationPacket("skin"), old = source.deformation.sources[0]!;
    const packet = { ...source, deformation: { ...source.deformation, sources: [{ ...old, skinning: {
      ...old.skinning!, joints: new Uint32Array(old.skinning!.joints) } }] } };
    expect(materializeRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(packet)), "$").deformation!.sources[0]!.skinning!.joints).toBeInstanceOf(Uint32Array);
    expect(materializeRuntimeRenderPacket(JSON.parse(JSON.stringify(source)), "$").deformation!.sources[0]!.skinning!.joints).toBeInstanceOf(Uint32Array);
  });
  it("rejects unknown source fields and invalid joint tags without dropping them", () => {
    const json = JSON.parse(serializeBrowserRenderPacket(deformationPacket()));
    json.deformation.sources[0].skinning.joints.componentType = "uint8";
    expect(() => materializeRuntimeRenderPacket(json, "$")).toThrow("component type");
    json.deformation.sources[0].skinning.joints.componentType = "uint16";
    json.deformation.sources[0].extra = 1;
    expect(() => materializeRuntimeRenderPacket(json, "$")).toThrow("Unknown deformation field");
  });
  it("rejects Native package export explicitly before Uint16 serialization", () => {
    const packet = deformationPacket();
    expect(() => normalizeRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(packet)))).toThrow("Native runtime package does not support deformation");
    expect(() => validateRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(packet)), "$")).toThrow("Native runtime package does not support deformation");
    expect(() => buildDeepRuntimePackage({ packageId: "probe", packageVersion: "1.0.0",
      renderPacket: { id: "render", revision: 1, value: packet } })).toThrow("Native runtime package does not support deformation");
  });
});
