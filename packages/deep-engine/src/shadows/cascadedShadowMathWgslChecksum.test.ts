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
    // J2-B1 后装配链单源:frame_bindings 不再直接 include_str,只经 native_mesh_wgsl
    // 两工厂消费;canonical include 唯一,住在 ordinary 工厂(native_mesh_shader_source),
    // RT 工厂由 ordinary 源拼接派生(前缀 ray-query enable + RT fragment),同源不变。
    const wiring = readFileSync(new URL("../../../deep-engine-native/src/native_mesh_wgsl.rs", import.meta.url), "utf8");
    expect(wiring.match(/include_str!\("\.\.\/\.\.\/deep-engine\/wgsl\/cascadedShadowMath\.wgsl"\)/g)).toHaveLength(1);
    expect(bindings).toContain("native_mesh_wgsl::native_mesh_shader_source()");
    expect(bindings).toContain("native_mesh_wgsl::native_mesh_rt_shader_source()");
    // RT 工厂必须经 ordinary 源消费同一 canonical 文件,不许私接第二份拷贝。
    const rtFactory = wiring.slice(wiring.indexOf("fn native_mesh_rt_shader_source"));
    expect(rtFactory).toContain("native_mesh_shader_source()");
    expect(bindings).not.toMatch(/include_str!\("[^"]*cascadedShadowMath\.wgsl"\)/);
    expect(source).not.toMatch(/@group|@binding|texture|sampler|array</);
  });
});
