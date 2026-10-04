// SMAA WGSL checksum 门禁(AA-M2 L3):三 pass present WGSL 与对角线/转角段的钉值
// (形态对齐 temporalAaWgslChecksum.test.ts;真机 GPU 行为由 smaaGpuAcceptanceProbe.mts 把守)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SMAA_EDGE_DETECTION_WGSL } from "./smaaEdgeDetectionWgsl.js";
import { SMAA_BLEND_WEIGHTS_WGSL } from "./smaaBlendWeightsWgsl.js";
import { SMAA_DIAG_WGSL } from "./smaaDiagWgsl.js";
import { SMAA_NEIGHBORHOOD_BLENDING_WGSL } from "./smaaNeighborhoodBlendingWgsl.js";
import { SMAA_BLEND_PASS_PRESENT_WGSL, SMAA_EDGE_PASS_PRESENT_WGSL, SMAA_WEIGHTS_PASS_PRESENT_WGSL } from "./smaaPresentWgsl.js";

const sha256 = (text: string): string => createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");

/** 钉值:任一 WGSL 段被改动(哪怕一个字符)都会在此被抓红;更新必须显式换算并注明依据。 */
const PINNED_SHA256 = {
  edge: "f69385da0b1ed2dc82f2da545ec6d91f009a707c47619002694110a317cdee49",
  weights: "91494e60e75bb61df9b0e539582a84e3b1682230b7dd8bd87e9ce7bc3a83a89e",
  diag: "a8e45122e2bb08bf8ae23a2f995dfaedc6eb7fede195e440a1737559220aa5e8",
  blend: "30f0d7e79924e33164841e073894577133d3d661d5f7ddc9e23bbef808148a05",
  present: ["917690d7956386d295178c200040452f023444f03b28ad61f4913e44656867d2",
    "f7aa57ddb791b336328e6df5b1082f7209b152e6679f2f20932950fd3089240c",
    "6872a452e2fa4b970bce6ea8744af803dc4cddaada8a20e64c9afec684a36433"],
};

describe("SMAA WGSL checksum gate", () => {
  it("pins every pass core and the assembled present modules by sha256", () => {
    expect(sha256(SMAA_EDGE_DETECTION_WGSL)).toBe(PINNED_SHA256.edge);
    expect(sha256(SMAA_BLEND_WEIGHTS_WGSL)).toBe(PINNED_SHA256.weights);
    expect(sha256(SMAA_DIAG_WGSL)).toBe(PINNED_SHA256.diag);
    expect(sha256(SMAA_NEIGHBORHOOD_BLENDING_WGSL)).toBe(PINNED_SHA256.blend);
    expect(sha256(SMAA_EDGE_PASS_PRESENT_WGSL)).toBe(PINNED_SHA256.present[0]);
    expect(sha256(SMAA_WEIGHTS_PASS_PRESENT_WGSL)).toBe(PINNED_SHA256.present[1]);
    expect(sha256(SMAA_BLEND_PASS_PRESENT_WGSL)).toBe(PINNED_SHA256.present[2]);
  });

  it("keeps the official formula markers (SMAA v2.8 function names) in the sources", () => {
    expect(SMAA_EDGE_DETECTION_WGSL).toContain("smaaColorEdgeDetectionPS");
    expect(SMAA_EDGE_DETECTION_WGSL).toContain("0.5 * maxDelta");
    expect(SMAA_BLEND_WEIGHTS_WGSL).toContain("smaaSearchXLeft");
    expect(SMAA_BLEND_WEIGHTS_WGSL).toContain("smaaSearchYDown");
    expect(SMAA_BLEND_WEIGHTS_WGSL).toContain("smaaAreaTexMaxDistance * round(4.0 * vec2f(e1, e2))");
    expect(SMAA_BLEND_WEIGHTS_WGSL).toContain("smaaCalculateDiagWeights");
    expect(SMAA_DIAG_WGSL).toContain("smaaSearchDiag1");
    expect(SMAA_DIAG_WGSL).toContain("smaaAreaDiag");
    expect(SMAA_DIAG_WGSL).toContain("smaaDetectHorizontalCornerPattern");
    expect(SMAA_NEIGHBORHOOD_BLENDING_WGSL).toContain("smaaNeighborhoodBlendingPS");
  });

  it("keeps the three-pass present modules self-contained (each declares its own bindings)", () => {
    for (const module of [SMAA_EDGE_PASS_PRESENT_WGSL, SMAA_WEIGHTS_PASS_PRESENT_WGSL, SMAA_BLEND_PASS_PRESENT_WGSL]) {
      expect(module).toContain("@group(0) @binding(0)");
      expect(module).toContain("@vertex fn vertexMain");
      expect(module).toContain("@fragment fn fragmentMain");
      expect(module).not.toContain("undefined");
    }
    // SMAA 1x: subsampleIndices = 0(权重查询 offset 恒 0;文本级锁定防误入 T2x 偏置)。
    expect(SMAA_BLEND_WEIGHTS_WGSL).not.toContain("subsampleIndices.z");
  });
});
