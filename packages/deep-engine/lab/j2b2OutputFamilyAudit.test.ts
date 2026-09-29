// J2-B2 输出家族漂移台账(可执行形态)。审计结论:输出/呈现阶段 WGSL 的 TS 侧
// (webgpu/pbrOutputShader 组合链、postprocess/bloomWgsl、webgpu/pbrFogWgsl)与
// Rust 侧副本(native_output_*.wgsl ×4、native_bloom_v1.wgsl)之间**不存在任何
// 逐字一致的可机械单源化对**——全部子家族带语义漂移,按任务卡纪律本批不硬迁,
// 漂移修复排后续批。本测试把台账钉成断言:
// 1. 六项漂移逐条锁死现状(后续批修复时必须有意更新对应断言,不许静默回漂);
// 2. Rust 内部 4 份输出 shader 的共享段哈希同值锁(副本摘除前的现状存证);
// 3. TS 输出家族组合产物基线转储(test-output/,后续批 before/after cmp 的基准)。
// 报告: docs/reports/j2b2-output-family-wgsl-audit-20260929.md
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
const rustOutputs = [rustPlain, rustBloomOutput, rustFogOutput, rustBloomFogOutput];

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** 从 startMarker 起到首个 endMarker 止的段(与报告台账的段哈希口径一致)。 */
const segment = (text: string, startMarker: string, endMarker: string): string => {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const end = text.indexOf(endMarker, start);
  return text.slice(start, end === -1 ? undefined : end + endMarker.length);
};

describe("J2-B2 输出家族漂移台账(现状锁,修复排后续批)", () => {
  it("DRIFT-1 ACES:TS 双档(Three 矩阵拟合+Narkowicz 曝光档)vs Rust 输出固定 Narkowicz 无曝光", () => {
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("deepThreeAcesFit");
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("0.59719"); // Three r185 矩阵拟合只在 TS 存在
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("2.51 * color + 0.03"); // Narkowicz 档 TS 亦有
    for (const shader of rustOutputs) {
      expect(shader).toContain("2.51 * color + 0.03");
      expect(shader).not.toContain("0.59719"); // native 输出无矩阵拟合
      expect(shader).not.toContain("exposure"); // native 输出无曝光参数
    }
  });

  it("DRIFT-2 线性→sRGB:TS deepLinearToSrgb 带 max 守卫,Rust linear_to_srgb 裸 pow(负输入语义差)", () => {
    expect(PBR_DISPLAY_COLOR_WGSL).toContain("pow(max(c, vec3f(0.0))");
    for (const shader of rustOutputs) {
      const seg = segment(shader, "fn linear_to_srgb", "\n}\n");
      expect(seg).toContain("pow(linear, vec3f(1.0 / 2.4))");
      expect(seg).not.toContain("max("); // 无守卫;当前调用域输入恒为 clamp 后 ACES 输出,安全但字面漂移
    }
  });

  it("DRIFT-3 作者分级:TS WGSL 无 abs/无白平衡门控/含 vignette 段,Rust author_grading_apply 有 abs/有门控/无 vignette(TS CPU 权威 applyPbrAuthorColorEffects 与 Rust 同侧)", () => {
    // TS WGSL(GPU 生产串)三缺:
    expect(PBR_AUTHOR_COLOR_EFFECTS_WGSL).not.toContain("abs(");
    expect(PBR_AUTHOR_COLOR_EFFECTS_WGSL).not.toContain("wb.x != 0.0");
    expect(PBR_AUTHOR_COLOR_EFFECTS_WGSL).toContain("1.0 - authorEffects.switches.w"); // vignette 段在 TS WGSL
    // TS CPU(白炉仲裁基准)与 Rust WGSL 同侧:abs + 门控。
    for (const shader of rustOutputs) {
      const seg = segment(shader, "fn author_grading_apply", "\n}\n");
      expect(seg).toContain("abs(dot(color, vec3f(0.2126, 0.7152, 0.0722)))");
      expect(seg).toContain("wb.x != 0.0 || wb.y != 0.0");
      expect(seg).not.toContain("vignette");
    }
  });

  it("DRIFT-4 vignette:TS outputShader 有径向 vignette smoothstep,Rust 输出链无 vignette(author_grading.rs 注释:槽位保留,vignette 属后续切片)", () => {
    expect(outputShader).toContain("settings.vignette * smoothstep(0.05, 0.5, radial)");
    for (const shader of rustOutputs) {
      expect(shader).not.toContain("vignette");
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

  it("Rust 内部副本现状锁:4 份输出 shader 的 aces/linear_to_srgb/author_grading/分级块四段逐字节同哈希(副本未摘除的存证;后续批摘除时更新)", () => {
    const segments = ["fn aces", "fn linear_to_srgb", "fn author_grading_apply", "struct AuthorGrading"] as const;
    const ends = ["\n}\n", "\n}\n", "\n}\n", "\n}\n"] as const;
    for (let s = 0; s < segments.length; s++) {
      const hashes = new Set(rustOutputs.map(shader => sha256(segment(shader, segments[s]!, ends[s]!))));
      expect(hashes.size, `${segments[s]} 段应四份同哈希(共享副本仍在)`).toBe(1);
      expect([...hashes][0], `${segments[s]} 段哈希非空`).not.toBe(sha256(""));
    }
  });

  it("TS 输出家族组合产物基线转储(test-output/j2b2-wgsl-baseline/,后续批 before/after cmp 基准)", () => {
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
    // 跨端判定存证:TS 五份产物与 Rust 五份 shader 无一逐字相等(本批 N=0 的机械依据)。
    const rustTexts = [...rustOutputs, rustBloom];
    for (const text of Object.values(products)) {
      for (const rust of rustTexts) {
        expect(sha256(text)).not.toBe(sha256(rust));
      }
    }
    writeFileSync(resolve(outDir, "manifest.txt"), manifest.join("\n") + "\n" +
      "cross-end byte-identical pairs: 0 (all six drift findings recorded)\n", "utf8");
  });
});
