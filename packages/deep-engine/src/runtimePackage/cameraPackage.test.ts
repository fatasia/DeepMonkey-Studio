import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRuntimePackageLodInput } from "../../scripts/runtimePackageLodFixture.mjs";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, serializeDeepRuntimePackage,
  runtimeContentSha256, runtimePackageSha256, validateDeepRuntimePackage, type BuildDeepRuntimePackageInput } from "./index.js";

const camera = () => JSON.parse(readFileSync(new URL("../../fixtures/runtime-camera-v1.json", import.meta.url), "utf8"));
const input = () => createRuntimePackageLodInput() as BuildDeepRuntimePackageInput;
const build = () => buildDeepRuntimePackage({ ...input(), camera: camera() });
function resign(value: any) {
  for (const entry of value.resources) entry.contentHash.value = runtimeContentSha256(value.payloads[entry.id]);
  value.packageHash.value = runtimePackageSha256(value);
  return value;
}
describe("camera runtime package v3", () => {
  it("roundtrips with an indexed, independently hashed camera and material bindings", () => {
    const value = build();
    expect(value.schemaVersion).toBe(3);
    const nativeFixture = JSON.parse(readFileSync(new URL("../../../deep-engine-native/tests/fixtures/runtime-package-camera-v3.json", import.meta.url), "utf8"));
    expect(value).toEqual(nativeFixture);
    expect(value).toHaveProperty("entrypoints.camera", "scene.camera");
    expect(value).toHaveProperty("materialBindings", []);
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(value))).toEqual({ valid: true, value, issues: [] });
  });
  it("keeps legacy versions and differentiates camera-only changes", () => {
    expect(buildDeepRuntimePackage(input()).schemaVersion).toBe(1);
    expect(() => buildDeepRuntimePackage({ ...input(), materialBindings: [] })).toThrow("v2 requires");
    const first = build(), changed = camera(); changed.position[0] += 1; changed.revision += 1;
    const next = buildDeepRuntimePackage({ ...input(), camera: changed });
    expect(next.packageHash).not.toEqual(first.packageHash);
    expect(next.resources.filter(e => e.kind !== "scene-camera")).toEqual(first.resources.filter(e => e.kind !== "scene-camera"));
  });
  it.each([
    (v: any) => { delete v.entrypoints.camera; },
    (v: any) => { v.entrypoints.camera = null; },
    (v: any) => { v.entrypoints.camera = v.entrypoints.renderPacket; },
    (v: any) => { delete v.materialBindings; },
    (v: any) => { v.payloads["scene.camera"].revision = 2; },
    (v: any) => { v.payloads["scene.camera"].id = "different"; },
    (v: any) => { v.payloads["scene.camera"].far = 0.01; },
    (v: any) => { v.schemaVersion = 2; },
    (v: any) => { v.schemaVersion = 4; },
  ])("rejects malformed or downgraded packages even after rehash", mutate => {
    const value = structuredClone(build()); mutate(value);
    expect(validateDeepRuntimePackage(resign(value)).valid).toBe(false);
  });
});
