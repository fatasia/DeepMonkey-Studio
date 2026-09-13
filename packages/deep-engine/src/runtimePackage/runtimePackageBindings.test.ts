import { describe, expect, it } from "vitest";
import { adaptDeepSlStandardToShaderPackage } from "../shaderAuthoring/packageAdapter.js";
import { OPAQUE, packageRequest } from "../shaderAuthoring/packageAdapter.testFixture.js";
import type { RenderPacket } from "../renderPacketTypes.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, runtimePackageSha256,
  serializeDeepRuntimePackage, validateDeepRuntimePackage, type DeepRuntimePackageV2 } from "./index.js";
import { normalizeRuntimeMaterialBindings } from "./materialBindings.js";

function shader(packageId = "deep.runtime.material", targetAbi = "deep.pbr.mesh.v2") {
  const result = adaptDeepSlStandardToShaderPackage({ ...packageRequest(OPAQUE), packageId, targetAbi });
  if (!result.success) throw new Error(JSON.stringify(result.report.issues));
  return result;
}
function input(ids = ["surface"]) {
  const compiled = shader(), defaults = compiled.report.materialDefaults!;
  const packet: RenderPacket = {
    geometries: [{ id: "triangle", revision: 0,
      vertices: new Float32Array([-1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]) }],
    materials: ids.map(id => ({ id, baseColor: defaults.baseColorMetallic.slice(0, 3) as [number, number, number],
      metallic: defaults.baseColorMetallic[3], roughness: defaults.roughnessAlphaCutoffHandednessFlags[0] })),
    instances: ids.map((material, index) => ({ id: `instance-${index}`, geometry: "triangle", material,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 3, 0, 0, 1] })),
  };
  return { packageId: "deep.runtime.bindings", packageVersion: "1.0.0",
    renderPacket: { id: "scene.main", revision: 1, value: packet },
    shaderPackages: [{ revision: 1, value: compiled.package }],
    materialBindings: ids.map(materialId => ({ materialId, packageId: compiled.package.packageId, techniqueId: "webgpu" })),
  };
}
function fixture(): DeepRuntimePackageV2 {
  const value = buildDeepRuntimePackage(input());
  if (value.schemaVersion !== 2) throw new Error("Expected runtime v2");
  return value;
}
function resign(value: DeepRuntimePackageV2): void {
  Object.assign(value, { packageHash: { algorithm: "sha256", value: runtimePackageSha256({ ...value }) } });
}
type EditableEnvelope = { schemaVersion: number; materialBindings?: Record<string, unknown>[] | null };
const binding = (value: EditableEnvelope) => value.materialBindings![0]!;

describe("runtime package executable material binding contract", () => {
  it("exports actual DeepSL values and CSM shader identity in a self-contained package", () => {
    const value = fixture();
    expect(value.materialBindings).toEqual([{ materialId: "surface", packageId: "deep.runtime.material", techniqueId: "webgpu" }]);
    expect(value.payloads["scene.main"]).toMatchObject({ materials: [{ baseColor: [0.12, 0.42, 0.9], metallic: 0.65, roughness: 0.24 }] });
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(value))).toEqual({ valid: true, value, issues: [] });
    expect(value.payloads["deep.runtime.material"]).toMatchObject({ shaderAbi: { id: "deep.pbr.mesh.v2" } });
  });

  it("sorts Unicode material ids like Rust and owns both material and binding input", () => {
    const source = input(["材质-𐀀", "材质-\ue000"]), built = buildDeepRuntimePackage(source);
    if (built.schemaVersion !== 2) throw new Error("Expected runtime v2");
    expect(built.materialBindings.map(binding => binding.materialId)).toEqual(["材质-\ue000", "材质-𐀀"]);
    source.materialBindings[0]!.techniqueId = "changed";
    (source.renderPacket.value.materials[0]!.baseColor as number[])[0] = 0.99;
    expect(built.materialBindings.every(binding => binding.techniqueId === "webgpu")).toBe(true);
    expect(validateDeepRuntimePackage(built).valid).toBe(true);
  });

  it.each([
    ["missing", (v: EditableEnvelope) => { delete v.materialBindings; }],
    ["null", (v: EditableEnvelope) => { v.materialBindings = null; }],
    ["empty", (v: EditableEnvelope) => { v.materialBindings = []; }],
    ["duplicate material", (v: EditableEnvelope) => { v.materialBindings!.push({ ...binding(v) }); }],
    ["absent material", (v: EditableEnvelope) => { binding(v).materialId = "absent"; }],
    ["absent shader", (v: EditableEnvelope) => { binding(v).packageId = "absent"; }],
    ["absent technique", (v: EditableEnvelope) => { binding(v).techniqueId = "absent"; }],
    ["unknown binding field", (v: EditableEnvelope) => { binding(v).fallback = true; }],
    ["null technique", (v: EditableEnvelope) => { binding(v).techniqueId = null; }],
    ["v1 with bindings", (v: EditableEnvelope) => { v.schemaVersion = 1; }],
  ])("rejects %s even after the complete manifest is rehashed", (_, mutate) => {
    const value = fixture(); mutate(value as unknown as EditableEnvelope); resign(value);
    expect(validateDeepRuntimePackage(value).valid).toBe(false);
  });

  it("rejects reordered bindings and detects binding-only tampering", () => {
    const value = buildDeepRuntimePackage(input(["alpha", "beta"]));
    if (value.schemaVersion !== 2) throw new Error("Expected runtime v2");
    (value.materialBindings as unknown[]).reverse(); resign(value);
    expect(validateDeepRuntimePackage(value).valid).toBe(false);
    const altered = fixture();
    Object.assign(altered.materialBindings[0]!, { techniqueId: "changed" });
    expect(validateDeepRuntimePackage(altered)).toMatchObject({ valid: false, issues: [{ message: expect.stringContaining("hash mismatch") }] });
  });

  it("refuses unbound shader entrypoints and legacy single-map shaders in v2", () => {
    const source = input();
    source.shaderPackages.push({ revision: 1, value: shader("deep.runtime.unused").package });
    expect(() => buildDeepRuntimePackage(source)).toThrow("Every shader entrypoint");
    const legacy = input(); legacy.shaderPackages[0]!.value = shader("deep.runtime.material", "deep.pbr.mesh.v1").package;
    expect(() => buildDeepRuntimePackage(legacy)).toThrow("CSM shader ABI");
  });

  it("rejects malformed author arrays before sorting or consuming accessors", () => {
    for (const value of [null, [], [null], [{ materialId: 1 }]]) {
      expect(() => normalizeRuntimeMaterialBindings(value)).toThrow();
    }
    const getter = { get materialId() { throw new Error("getter executed"); }, packageId: "p", techniqueId: "t" };
    expect(() => normalizeRuntimeMaterialBindings([getter])).toThrow("Accessors");
  });
});
