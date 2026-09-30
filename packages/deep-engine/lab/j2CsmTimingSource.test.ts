import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { csmTimingOrder, csmTimingReference, csmTimingShader } from "./j2CsmTimingSource.js";
const math = readFileSync(new URL("../wgsl/cascadedShadowMath.wgsl", import.meta.url), "utf8");
const native = readFileSync(new URL("../../deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl", import.meta.url), "utf8");
const source = `${math}\n${native}`;
const entry = readFileSync(new URL("../fixtures/j2-csm-timing-entry.wgsl", import.meta.url), "utf8");
describe("CSM timing reference source", () => {
  it("changes only non-blend early return and preserves zero-width safety", () => {
    const reference = csmTimingReference(source);
    expect(reference.replace("return blendStart >= split;", "return blendStart >= split || viewDepth <= blendStart;")).toBe(source);
    expect(() => csmTimingReference("old source")).toThrow();
    expect(() => csmTimingReference(source + math)).toThrow();
  });
  it("uses five alternating paired rounds", () => {
    expect([1,2,3,4,5].map(csmTimingOrder)).toEqual([
      ["reference","candidate"],["candidate","reference"],["reference","candidate"],
      ["candidate","reference"],["reference","candidate"],
    ]);
    expect(() => csmTimingOrder(6)).toThrow();
  });
  it("freezes complete shader identities with common entry", () => {
    const uvs = [.125,.25,.375,.5,.625,.75,.875];
    const candidate = csmTimingShader(source, entry, [1,1.7,1.8], uvs);
    const reference = csmTimingShader(csmTimingReference(source), entry, [1,1.7,1.8], uvs);
    expect(candidate.sourceHash).not.toBe(reference.sourceHash);
    expect(candidate.code).not.toContain("TIMING_");
    expect(candidate.code).toContain("shadow_visibility(world,vec3f(0),1.0)");
  });
});
