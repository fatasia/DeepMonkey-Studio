import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASCADED_SHADOW_MATH_WGSL } from "./cascadedShadowMathWgsl.js";
import { CASCADED_SHADOW_WGSL } from "./cascadedShadowShader.js";
import { DEEP_PACKAGE_CSM_WGSL } from "../shaderAuthoring/packageAdapterCsm.js";

const source = readFileSync(new URL("../../wgsl/cascadedShadowMath.wgsl", import.meta.url), "utf8");
const [hash, length] = readFileSync(new URL("../../wgsl/cascadedShadowMath.wgsl.sha256", import.meta.url), "utf8").trim().split(/\s+/);
const bindings = readFileSync(new URL("../../../deep-engine-native/src/frame_bindings.rs", import.meta.url), "utf8");

describe("CSM blend source identity", () => {
  it("keeps the generated mirror and pinned bytes on the canonical source", () => {
    expect(CASCADED_SHADOW_MATH_WGSL).toBe(source);
    expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
    expect(Buffer.byteLength(source)).toBe(Number(length));
  });

  it.each([CASCADED_SHADOW_WGSL, DEEP_PACKAGE_CSM_WGSL])("embeds the binding-free common kernel once", shader => {
    expect(shader.split(source)).toHaveLength(2);
    expect(shader.match(/fn deepCascadeBlendInactive\(/g)).toHaveLength(1);
    expect(shader.match(/fn deepCascadeBlendWeight\(/g)).toHaveLength(1);
  });

  it("wires the same canonical file to ordinary and RT production factories", () => {
    expect(bindings.match(/include_str!\("\.\.\/\.\.\/deep-engine\/wgsl\/cascadedShadowMath\.wgsl"\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/@group|@binding|texture|sampler|array</);
  });
});
