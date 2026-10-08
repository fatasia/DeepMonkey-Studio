// J2-B2 live audit: shared ACES/sRGB now feed both hosts; output policy, author
// grading, vignette, bloom and fog retain their explicitly different contracts.
// The original byte-preserving migration and hashes are recorded in 0a0b26fa.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { outputShader } from "../src/webgpu/pbrOutputShader.js";
import { PBR_DISPLAY_COLOR_WGSL } from "../src/webgpu/pbrDisplayColorWgsl.js";
import { PBR_AUTHOR_COLOR_EFFECTS_WGSL } from "../src/webgpu/pbrAuthorColorEffectsWgsl.js";
import { PBR_FOG_WGSL } from "../src/webgpu/pbrFogWgsl.js";
import { BLOOM_WGSL } from "../src/postprocess/bloomWgsl.js";

const nativeShaders = resolve(import.meta.dirname, "../../deep-engine-native/assets/shaders");
const readShader = (name: string): string => {
  try {
    return readFileSync(resolve(nativeShaders, name), "utf8");
  } catch {
    throw new Error(`native shader assets not found at ${nativeShaders} — deep-engine-native 布局变更时同步更新本审计测试的路径。`);
  }
};

const rustPlain = readShader("native_output_v1.wgsl");
const rustBloomOutput = readShader("native_output_bloom_v1.wgsl");
const rustFogOutput = readShader("native_output_fog_v1.wgsl");
const rustBloomFogOutput = readShader("native_output_bloom_fog_v1.wgsl");
const rustBloom = readShader("native_bloom_v1.wgsl");
const rustColor = readShader("native_output_color.wgsl");
const rustAssembly = readFileSync(resolve(nativeShaders, "../../src/output_pass.rs"), "utf8");
const rustOutputs = [rustPlain, rustBloomOutput, rustFogOutput, rustBloomFogOutput];

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** 从 startMarker 起到首个 endMarker 止的段(与报告台账的段哈希口径一致)。 */
const segment = (text: string, startMarker: string, endMarker: string): string => {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const end = text.indexOf(endMarker, start);
  return text.slice(start, end === -1 ? undefined : end + endMarker.length);
};

describe("J2-B2 shared output math and remaining policy differences", () => {
  it("shares ACES math while retaining TS dual modes and native upstream exposure", () => {
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("deepThreeAcesFit");
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("0.59719");
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("2.51 * color + 0.03");
    expect(rustColor).toContain("deepAcesFit(color, 1.0)");
    expect(rustColor).not.toContain("deepThreeAcesFit(");
    expect(rustAssembly).toContain('include_str!("../../deep-engine/wgsl/displayColor.wgsl")');
    for (const shader of rustOutputs) {
      expect(shader).toContain("aces(");
      expect(shader).not.toContain("2.51 * color + 0.03");
      expect(shader).not.toContain("exposure");
    }
  });

  it("shares guarded linear-to-sRGB instead of four bare-pow copies", () => {
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("pow(max(c, vec3f(0.0))");
    expect(segment(rustColor, "fn linear_to_srgb", "\n}\n")).toContain("deepLinearToSrgb(linear)");
    for (const shader of rustOutputs) expect(shader).not.toContain("fn linear_to_srgb");
  });

  it("shares the white-balance guard and absolute denominator; both hosts apply author vignette", () => {
    expect(PBR_AUTHOR_COLOR_EFFECTS_WGSL).toContain("max(abs(dot(color, vec3f(0.2126, 0.7152, 0.0722)))");
    expect(PBR_AUTHOR_COLOR_EFFECTS_WGSL).toContain("wb.x != 0.0 || wb.y != 0.0");
    expect(PBR_AUTHOR_COLOR_EFFECTS_WGSL).toContain("1.0 - authorEffects.switches.w"); // vignette 段在 TS WGSL
    // TS CPU(白炉仲裁基准)与 Rust WGSL 同侧:abs + 门控。
    const seg = segment(rustColor, "fn author_grading_apply", "\n}\n");
    expect(seg).toContain("abs(dot(color, vec3f(0.2126, 0.7152, 0.0722)))");
    expect(seg).toContain("wb.x != 0.0 || wb.y != 0.0");
    expect(seg).toContain("if (author_grading.switches.y > 0.5)");
    expect(seg).toContain("1.0 - author_grading.switches.w");
    for (const shader of rustOutputs) expect(shader).toContain("author_grading_apply(");
  });

  it("feeds actual normalized viewport UV to native author vignette; TS legacy output vignette retains its own policy", () => {
    expect(outputShader).toContain("settings.vignette * smoothstep(0.05, 0.5, radial)");
    for (const shader of rustOutputs) {
      expect(shader).toContain("input.position.xy / vec2f(textureDimensions(hdr_color))");
      expect(shader).toContain("author_grading_apply(hdr.rgb, vignette_uv)");
    }
  });

  it("DRIFT-5 bloom:TS compute@8x8 storage-write box 降采样+5tap 高斯(0.0625/0.25/0.375)vs Rust fragment 9tap 高斯(0.227027/0.316216/0.070270),架构级不同", () => {
    expect(BLOOM_WGSL).toContain("texture_storage_2d");
    expect(BLOOM_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(BLOOM_WGSL).toContain("0.0625");
    expect(rustBloom).toContain("@fragment");
    expect(rustBloom).not.toContain("texture_storage_2d");
    expect(rustBloom).toContain("0.227027");
  });

  it("DRIFT-6 雾:TS PBR_FOG_WGSL 场景域 uniform(group0 binding8,作者雾/场景雾)vs Rust 输出通全屏深度雾 march(depth-msaa+高度积分),域不同", () => {
    expect(PBR_FOG_WGSL).toContain("@group(0) @binding(8) var<uniform> deepFog: DeepFog;");
    expect(PBR_FOG_WGSL).toContain("deepApplyAuthorFog");
    expect(rustFogOutput).toContain("texture_depth_multisampled_2d");
    expect(rustFogOutput).toContain("let sample_height = frame.eye.y + ray.y * sample_distance");
    expect(PBR_FOG_WGSL).not.toContain("texture_depth_multisampled_2d");
  });

  it("keeps all four native output bodies free of copied color libraries", () => {
    const segments = ["fn aces", "fn linear_to_srgb", "fn author_grading_apply", "struct AuthorGrading"] as const;
    const ends = ["\n}\n", "\n}\n", "\n}\n", "\n}\n"] as const;
    for (let s = 0; s < segments.length; s++) {
      expect(segment(rustColor, segments[s]!, ends[s]!)).not.toBe("");
      for (const shader of rustOutputs) expect(shader).not.toContain(segments[s]!);
    }
  });

  it("dumps current composed artifacts while host bodies retain distinct bindings", () => {
    const products: Record<string, string> = {
      "outputShader.wgsl": outputShader,
      "pbrDisplayColor.wgsl": PBR_DISPLAY_COLOR_WGSL,
      "pbrAuthorColorEffects.wgsl": PBR_AUTHOR_COLOR_EFFECTS_WGSL,
      "pbrFog.wgsl": PBR_FOG_WGSL,
      "bloom.wgsl": BLOOM_WGSL,
    };
    const outDir = resolve(import.meta.dirname, "../../test-output/j2b2-wgsl-baseline");
    mkdirSync(outDir, { recursive: true });
    const manifest = Object.entries(products).map(([name, text]) =>
      `${name}\t${new TextEncoder().encode(text).length} bytes\tsha256=${sha256(text)}`);
    for (const [name, text] of Object.entries(products)) {
      writeFileSync(resolve(outDir, name), text, "utf8");
    }
    // Host bodies differ; this does not imply that their shared math differs.
    const rustTexts = [...rustOutputs, rustBloom];
    for (const text of Object.values(products)) {
      for (const rust of rustTexts) {
        expect(sha256(text)).not.toBe(sha256(rust));
      }
    }
    writeFileSync(resolve(outDir, "manifest.txt"), manifest.join("\n") + "\n" +
      "host bodies differ; ACES/sRGB math is shared; remaining policies stay explicit\n", "utf8");
  });
});
