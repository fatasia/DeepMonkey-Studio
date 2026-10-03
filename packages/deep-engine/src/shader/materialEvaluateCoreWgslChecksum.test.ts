import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinned from "../../wgsl/materialEvaluateCore.wgsl.sha256?raw";
import source from "../../wgsl/materialEvaluateCore.wgsl?raw";
import { EXTENDED_MATERIAL_CORE_WGSL } from "./materialEvaluateCoreWgsl.js";
import { EXTENDED_MATERIAL_EVALUATION_WGSL } from "./materialEvaluateWgsl.js";
import { EXTENDED_PARAMETER_WGSL_STRUCT } from "./materialParameterAbi.js";
import { MATERIAL_DIELECTRIC_WGSL } from "../materialDielectric.js";

describe("T08 shared material evaluator source", () => {
  it("has one canonical core and the pinned checksum", () => {
    const [hash, bytes] = pinned.trim().split(/\s+/);
    expect(EXTENDED_MATERIAL_CORE_WGSL).toBe(source);
    expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
    expect(new TextEncoder().encode(source).length).toBe(Number(bytes));
  });
  it("keeps the parameter ABI and defers dielectric composition to the host", () => {
    expect(source.split(EXTENDED_PARAMETER_WGSL_STRUCT)).toHaveLength(2);
    expect(source).not.toContain("fn deepDielectricF0(");
    expect(EXTENDED_MATERIAL_EVALUATION_WGSL.split(MATERIAL_DIELECTRIC_WGSL)).toHaveLength(2);
    expect(EXTENDED_MATERIAL_EVALUATION_WGSL.replace(MATERIAL_DIELECTRIC_WGSL, "")).toBe(source);
  });
  it("defines pure functions without entrypoints or resources", () => {
    expect(source).toContain("fn deepEvaluateExtendedMaterial(");
    expect(source).not.toMatch(/@group|@binding|@fragment|@compute|textureSample/);
  });
});
