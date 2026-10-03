import { expect, it } from "vitest";
import { normalizeLayeredSurfaceParameters, packLayeredSurfaceBlock, type LayeredSurfaceOverrides } from "./materialLayeredSurface.js";
import { deserializeLayeredMaterialParameters, serializeLayeredMaterialParameters, packLayeredMaterialFloatArray } from "./materialLayeredParameters.js";
import { evaluateLayeredMaterialDirect } from "./materialLayeredEvaluate.js";
import { layeredMaterialExtension } from "../runtimePackage/renderPacketBrowserMaterial.js";
import { assertNativeLayeredMaterialSupported } from "../runtimePackage/renderPacketNativeMaterial.js";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "../runtimePackage/index.js";
import { materializeRuntimeRenderPacket } from "../runtimePackage/renderPacket.js";
import type { RenderPacket } from "../renderPacketTypes.js";
const layer = { responseModel: "microfacet-metal-reflection" as const, coverage: .75,
  params: { anisotropy: { strength: .8, rotation: .3 } }, surface: { metallic: 1, baseColor: [.8, .4, .1] as const, roughness: .35 } };
function check(input: LayeredSurfaceOverrides) {
  const normalized = layeredMaterialExtension({ layered: input }, "$.material");
  assertNativeLayeredMaterialSupported(normalized, "$.material.layered"); return normalized;
}
it("preserves an explicit model through public package build, validation and materialization", () => {
  const packet: RenderPacket = { materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: .5,
    layered: { layers: [layer] } }], geometries: [], textures: [], instances: [] };
  const before = structuredClone(packet);
  const result = buildDeepRuntimePackage({ packageId: "metal.profile", packageVersion: "0.1.0",
    renderPacket: { id: "scene.main", revision: 1, value: packet } });
  expect(validateDeepRuntimePackage(result).valid).toBe(true);
  const restored = materializeRuntimeRenderPacket(result.payloads["scene.main"], "$.packet");
  expect(restored.materials[0]!.layered!.layers![0]!.responseModel).toBe(layer.responseModel);
  expect(packet).toEqual(before);
});
it.each([0, 1e-7, .01, 1])("accepts the conductor domain at strength %s", strength => {
  expect(() => check({ layers: [{ ...layer, params: { anisotropy: { strength, rotation: 0 } } }] })).not.toThrow();
});
it("consumes reserved flag bit3 without changing the 304B/header/row ABI", () => {
  const params = normalizeLayeredSurfaceParameters({ layers: [{ coverage: 0 }, layer] });
  const block = packLayeredSurfaceBlock(params), words = new Uint32Array(block.buffer);
  expect(block.byteLength).toBe(304); expect(words[0]).toBe(1); expect(words[1]).toBe(1);
  expect(block[19]).toBe(15); expect(block[7]).toBe(Math.fround(.8)); expect(block[8]).toBe(Math.fround(.3));
  expect(block[16]).toBe(1); expect(block[4 + 36]).toBe(0);
});
it.each([{ surface: { metallic: .999 } }, { surface: {} },
  { surface: { metallic: 1, metallicRoughnessTexture: { texture: "mr" } } },
  { params: { clearcoat: { factor: .1 } } }, { params: { transmission: { factor: .1 } } },
  { params: { anisotropy: { rotation: 4 } } }])("rejects an unsupported active model domain: %j", override => {
  expect(() => check({ layers: [{ ...layer, ...override }] })).toThrow(/microfacet-metal-reflection/);
});
it("keeps legacy Native anisotropy rejected and preserves coverage-zero pruning", () => {
  expect(() => check({ layers: [{ coverage: 1, params: layer.params }] })).toThrow(/anisotropy.strength/);
  const zero = { ...layer, coverage: 0, surface: {} };
  expect(packLayeredSurfaceBlock(normalizeLayeredSurfaceParameters({ layers: [zero] })))
    .toEqual(packLayeredSurfaceBlock(normalizeLayeredSurfaceParameters({ layers: [] })));
  expect(() => check({ layers: [{ ...zero, responseModel: "unknown" as never }] })).toThrow(/response model/);
  expect(() => check({ layers: [{ ...zero, params: { anisotropy: { strength: 2 } } }] })).toThrow();
});
it("preserves the model in JSON while failing closed on old scalar-only APIs", () => {
  const params = normalizeLayeredSurfaceParameters({ layers: [layer] });
  expect(deserializeLayeredMaterialParameters(serializeLayeredMaterialParameters(params))).toMatchObject({ layers: [{ responseModel: layer.responseModel }] });
  expect(() => packLayeredMaterialFloatArray(params)).toThrow(/22-float/);
  expect(() => evaluateLayeredMaterialDirect({ baseColor: [1, 1, 1], metallic: 1, roughness: .5 }, params,
    { normal: [0, 0, 1], view: [0, 0, 1], light: [0, 0, 1] })).toThrow(/surface-aware/);
});
it("retains independent color/alpha UV transforms and unsigned texture indexing", () => {
  const textured = { ...layer, surface: { ...layer.surface, baseColorTexture: { texture: "color", texCoord: 1 as const } } };
  expect(() => check({ layers: [textured] })).not.toThrow();
  const block = packLayeredSurfaceBlock(normalizeLayeredSurfaceParameters({ layers: [textured] }), [{
    baseColor: { slot: { texture: "color", texCoord: 1, uvTransform: [2, 0, .1, 0, 3, .2] }, arrayLayer: 0xffff_ffff } }]);
  expect(Array.from(block.slice(20, 28))).toEqual([2, 0, Math.fround(.1), 2, 0, 3, Math.fround(.2), 0]);
  expect(new Uint32Array(block.buffer)[36]).toBe(0xffff_ffff);
});
it.each([-Math.PI, Math.PI, -Math.fround(Math.PI), Math.fround(Math.PI)])("keeps float32 half-turn %s stable through repeated JSON normalization", rotation => {
  const input = { layers: [{ ...layer, params: { anisotropy: { strength: 1, rotation } } }] };
  const normalized = normalizeLayeredSurfaceParameters(input);
  const angle = normalized.layers[0]!.params.anisotropy.rotation;
  expect(angle).toBe(Math.fround(Math.PI));
  expect(deserializeLayeredMaterialParameters(serializeLayeredMaterialParameters(normalized)).layers[0]!.params.anisotropy.rotation).toBe(angle);
  const parsed = layeredMaterialExtension({ layered: JSON.parse(JSON.stringify(input)) }, "$.material");
  const reparsed = layeredMaterialExtension({ layered: JSON.parse(JSON.stringify(parsed)) }, "$.material");
  expect(reparsed!.layers![0]!.params!.anisotropy!.rotation).toBe(angle);
});
