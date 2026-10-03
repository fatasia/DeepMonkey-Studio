import { describe, expect, it } from "vitest";
import { assertNativeLayeredMaterialSupported } from "./renderPacketNativeMaterial.js";
import { layeredMaterialExtension } from "./renderPacketBrowserMaterial.js";
import type { LayeredSurfaceOverrides } from "../shader/materialLayeredSurface.js";
import { normalizeExtendedMaterialParameters, type MaterialParameterOverrides } from "../shader/materialParameters.js";
import { RuntimePackageError } from "./primitives.js";
import { buildDeepRuntimePackage, validateDeepRuntimePackage, runtimeContentSha256, runtimePackageSha256 } from "./index.js";
import { materializeRuntimeRenderPacket, serializeBrowserRenderPacket } from "./renderPacket.js";
import type { RenderPacket } from "../renderPacketTypes.js";

const path = "$.renderPacket.materials[0].layered";
function check(input: LayeredSurfaceOverrides) {
  const normalized = layeredMaterialExtension({ layered: input }, "$.renderPacket.materials[0]");
  assertNativeLayeredMaterialSupported(normalized, path);
  return normalized;
}
const lobes: readonly [string, MaterialParameterOverrides][] = [
  ["clearcoat.factor", { clearcoat: { factor: .7, roughness: .3 } }],
  ["anisotropy.strength", { anisotropy: { strength: .8, rotation: .3 } }],
  ["transmission.factor", { transmission: { factor: .6 } }],
];

describe("Native layered stock response support", () => {
  it.each(lobes.slice(1))("rejects active layer %s with its exact path", (field, params) => {
    const invoke = () => check({ layers: [{ coverage: .5, params }] });
    expect(invoke).toThrow(RuntimePackageError);
    expect(invoke).toThrow(`${path}.layers[0].params.${field}: Native layered materials do not support nonzero ${field}.`);
  });
  it.each(lobes)("rejects active stack base %s", (field, base) => {
    expect(() => check({ base, layers: [{ coverage: .5 }] })).toThrow(`${path}.base.${field}:`);
  });
  it.each(lobes.slice(1))("keeps original index when first layer is pruned: %s", (field, params) => {
    expect(() => check({ layers: [{ coverage: 0, params }, { coverage: .2, params }] }))
      .toThrow(`${path}.layers[1].params.${field}:`);
  });
  it.each(lobes)("permits pruned layer %s beside a supported active layer", (_field, params) => {
    expect(() => check({ layers: [{ coverage: 0, params }, { coverage: .2 }] })).not.toThrow();
  });
  it.each(lobes)("permits an inactive stack with base %s", (_field, base) => {
    expect(() => check({ base, layers: [] })).not.toThrow();
    expect(() => check({ base, layers: [{ coverage: 0, params: base }] })).not.toThrow();
    expect(() => check({ base, layers: [{ params: base }] })).not.toThrow();
  });
  it("allows zero factors with nonzero neutral roughness/rotation and consumes valid layer IOR", () => {
    const params = { ior: 1.2, clearcoat: { factor: 0, roughness: .9 },
      anisotropy: { strength: 0, rotation: Math.PI * 7 }, transmission: { factor: 0 } };
    const input = { base: params, layers: [{ coverage: .5, params, surface: {
      baseColor: [.25, .5, .75] as const, metallic: .875, roughness: .75,
      baseColorTexture: { texture: "color", texCoord: 1 as const },
      metallicRoughnessTexture: { texture: "mr", texCoord: 0 as const },
    } }] };
    const before = structuredClone(input), normalized = check(input);
    expect(input).toEqual(before);
    expect(normalized?.layers?.[0]?.params?.ior).toBe(Math.fround(1.2));
    expect(normalized?.layers?.[0]?.params?.anisotropy?.rotation).toBeCloseTo(Math.PI, 5);
    expect(normalized?.layers?.[0]?.surface).toMatchObject(input.layers[0]!.surface);
  });
  it("permits an absent stack", () => {
    expect(() => assertNativeLayeredMaterialSupported(undefined, path)).not.toThrow();
  });
  it.each(lobes)("leaves Browser normalization of %s available", (_field, params) => {
    const normalized = layeredMaterialExtension({ layered: { base: params, layers: [{ coverage: .5, params }] } }, "$.material");
    expect(normalized?.layers?.[0]?.coverage).toBe(.5);
    expect(normalized?.layers?.[0]?.params).toEqual(normalizeExtendedMaterialParameters(params));
  });
  it.each([
    { ior: .9 }, { ior: Infinity }, { clearcoat: { factor: -1 } }, { clearcoat: { roughness: 2 } },
    { anisotropy: { strength: -1 } }, { anisotropy: { rotation: NaN } }, { transmission: { factor: 2 } },
  ])("retains the existing numeric rejection for pruned rows: %j", params => {
    expect(() => check({ layers: [{ coverage: 0, params }] })).toThrow();
  });
});

function packet(layered: LayeredSurfaceOverrides): RenderPacket {
  return { geometries: [{ id: "g", revision: 0,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [.2, .3, .4], metallic: .1, roughness: .8, layered }],
    instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] };
}
function publish(source: RenderPacket) {
  return buildDeepRuntimePackage({ packageId: "deep.i23.profile", packageVersion: "0.1.0",
    renderPacket: { id: "scene.main", revision: 1, value: source } });
}
describe("Native runtime package publish consumption", () => {
  it.each(lobes.slice(1))("rejects %s through the public builder without mutating input", (field, params) => {
    const source = packet({ layers: [{ coverage: .5, params }] }), before = structuredClone(source);
    expect(() => publish(source)).toThrow(`${path}.layers[0].params.${field}:`);
    expect(source).toEqual(before);
  });
  it.each(lobes.slice(1))("rejects %s even when an unsupported package is correctly re-signed", (field, params) => {
    const result = structuredClone(publish(packet({ layers: [{ coverage: .5 }] })));
    const payload = result.payloads["scene.main"] as unknown as { materials: { layered: LayeredSurfaceOverrides }[] };
    payload.materials[0]!.layered = { layers: [{ coverage: .5, params }] };
    result.resources.find(resource => resource.id === "scene.main")!.contentHash.value = runtimeContentSha256(payload);
    result.packageHash.value = runtimePackageSha256(result);
    const validation = validateDeepRuntimePackage(result);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(field) })]));
  });
  it.each(lobes)("rejects active base %s through public publishing", (_field, base) => {
    expect(() => publish(packet({ base, layers: [{ coverage: .5 }] }))).toThrow(`${path}.base.`);
  });
  it.each(lobes)("keeps Browser %s roundtrip available", (_field, params) => {
    const source = packet({ base: params, layers: [{ coverage: .5, params }] });
    const restored = materializeRuntimeRenderPacket(JSON.parse(serializeBrowserRenderPacket(source)), "$.packet");
    expect(restored.materials[0]!.layered?.base).toEqual(normalizeExtendedMaterialParameters(params));
    expect(restored.materials[0]!.layered?.layers?.[0]?.params).toEqual(normalizeExtendedMaterialParameters(params));
  });
  it("publishes stock layers with neutral rotation/roughness and pruned unsupported lobes", () => {
    const source = packet({ base: { clearcoat: { factor: 0, roughness: .9 }, anisotropy: { strength: 0, rotation: 9 } },
      layers: [{ coverage: 0, params: { transmission: { factor: 1 } } },
        { coverage: .5, params: { ior: 1.2, clearcoat: { factor: 0, roughness: .8 } } }] });
    expect(validateDeepRuntimePackage(publish(source)).valid).toBe(true);
  });
});


it("publishes active layer clearcoat and roundtrips its factor/roughness without input mutation", () => {
  const source = packet({ layers: [{ coverage: 0, params: { transmission: { factor: 1 } } },
    { coverage: .75, params: { clearcoat: { factor: .7, roughness: .3 } } }] });
  const before = structuredClone(source), built = publish(source);
  expect(validateDeepRuntimePackage(built).valid).toBe(true); expect(source).toEqual(before);
  const restored = materializeRuntimeRenderPacket(built.payloads["scene.main"], "$.packet");
  expect(restored.materials[0]!.layered?.layers?.[1]?.params?.clearcoat)
    .toEqual({ factor: Math.fround(.7), roughness: Math.fround(.3) });
});
