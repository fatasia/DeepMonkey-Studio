import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PBR_DISPLAY_COLOR_WGSL } from "./pbrDisplayColorWgsl.js";
import { PBR_OUTPUT_BODY_WGSL } from "./pbrOutputBodyWgsl.js";
import { PBR_DIRECT_DISPLAY_BODY_WGSL } from "./pbrDirectDisplayBodyWgsl.js";
import { outputShader } from "./pbrOutputShader.js";
import { PBR_DIRECT_DISPLAY_WGSL } from "./pbrDirectDisplayWgsl.js";
import { RT_SHADOW_BRANCH_BLOCK } from "./pbrShader.js";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
describe("J2-B2 output family single source", () => {
  for (const [name, code] of Object.entries({ displayColor: PBR_DISPLAY_COLOR_WGSL,
    outputShader: PBR_OUTPUT_BODY_WGSL, directDisplay: PBR_DIRECT_DISPLAY_BODY_WGSL })) {
    it(`${name}: mirror and pinned bytes match source`, () => {
      const source = readFileSync(new URL(`../../wgsl/${name}.wgsl`, import.meta.url), "utf8");
      const [sha, bytes] = readFileSync(new URL(`../../wgsl/${name}.wgsl.sha256`, import.meta.url), "utf8").trim().split(/\s+/);
      expect(code).toBe(source);
      expect(hash(code)).toBe(sha);
      expect(Buffer.byteLength(code)).toBe(Number(bytes));
    });
  }
  it("pins production compositions after shared native ACES extraction", () => {
    // The original byte-preserving migration is recorded in 0a0b26fa.
    // B1 Brief-VSM(2026-10-03):deepPrimaryShadow 增 params2 虚拟档分支(级联档行为逐字节保持),
    // diff 见 docs/specs/ue-class-b1-vsm-implementation-20261003.md。
    expect(hash(outputShader)).toBe("ea713797ed4d06b8c3b70b128dfe1a7f8f993015885b5e977f3cf5a713686366");
    expect(hash(PBR_DIRECT_DISPLAY_WGSL)).toBe("0e3c468cf96ddd174dcdd25e953848b77a60f08db63997fbf33d2ed70d19a335");
  });
  it("keeps the default composition byte-identical when the M2 RT shadow branch is stripped", () => {
    // M2 光追阴影(2026-10-04):真源 deepPrimaryShadow 增 RT mask 分支块(条件注入)。
    // 默认档 pbrShader.ts 剥离 RT_SHADOW_BRANCH_BLOCK 后的组合体必须与历史钉值逐字节
    // 一致 —— 本断言即「rayTracedShadows=false 默认零变化」的机器证明(钉值
    // 76611dda… 在该切片中保持不更新;含 RT 块的新钉值见上一用例,提交信息同步说明)。
    expect(hash(PBR_DIRECT_DISPLAY_WGSL.replace(RT_SHADOW_BRANCH_BLOCK, "")))
      .toBe("76611dda4cba180670152abce488e6fd989c4fc55a1a9e68ef159b06c854b60f");
    // RT 变体保留分支且只多注入 group(2) binding(3) mask 声明(声明文本由 pbrShader 持有)。
    expect(PBR_DIRECT_DISPLAY_WGSL.includes(RT_SHADOW_BRANCH_BLOCK)).toBe(true);
    expect(PBR_DIRECT_DISPLAY_WGSL.replace(RT_SHADOW_BRANCH_BLOCK, "").includes("deepRayTracedShadowMask")).toBe(false);
  });
  it("keeps composed libraries outside leaf sources", () => {
    expect(PBR_OUTPUT_BODY_WGSL).not.toContain("fn deepDisplayColor");
    expect(PBR_OUTPUT_BODY_WGSL).not.toContain("fn deepAuthorColor");
    expect(PBR_DIRECT_DISPLAY_BODY_WGSL).not.toContain("struct DeepDiffuseIrradiance");
    expect(outputShader.split("fn deepDisplayColor")).toHaveLength(2);
    expect(PBR_DIRECT_DISPLAY_WGSL.split("struct DeepDiffuseIrradiance")).toHaveLength(2);
  });
});
