import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOOM_WGSL } from "../src/postprocess/bloomWgsl.js";
import { bloomPrefilterArithmeticForProbe, bloomPrefilterCpuReference } from "./j2BloomPrefilterGpuProbe.js";

describe("B6 probe production boundaries and independent CPU reference", () => {
  it("extracts actual old and current production formulas, failing on moved boundaries", () => {
    const nativePath = "packages/deep-engine-native/assets/shaders/native_bloom_v1.wgsl";
    const oldTs = execFileSync("git", ["show", "cbce805a:packages/deep-engine/src/postprocess/bloomWgsl.ts"], { encoding: "utf8" });
    const oldNative = execFileSync("git", ["show", `cbce805a:${nativePath}`], { encoding: "utf8" });
    const currentNative = readFileSync(new URL("../../deep-engine-native/assets/shaders/native_bloom_v1.wgsl", import.meta.url), "utf8");
    expect(bloomPrefilterArithmeticForProbe(oldTs, "ts-max-rgb")).toContain("transition * transition / (4.0 * knee)");
    expect(bloomPrefilterArithmeticForProbe(BLOOM_WGSL, "ts-max-rgb")).toContain("deepBloomSoftKnee");
    expect(bloomPrefilterArithmeticForProbe(oldNative, "native-max-rgb")).toContain("4.0 * knee + 0.00001");
    expect(bloomPrefilterArithmeticForProbe(currentNative, "native-max-rgb")).toContain("deepBloomSoftKnee(brightness, bloom.threshold, knee, 0.00001)");
    expect(() => bloomPrefilterArithmeticForProbe("", "native-max-rgb")).toThrow("Missing production function");
  });
  it("keeps the Native knee floor at hard threshold while TS remains zero", () => {
    const test = { id: "at", color: [1, .2, .1], threshold: 1, softKnee: 0 };
    expect(bloomPrefilterCpuReference(test, "ts-max-rgb")).toEqual([0, 0, 0]);
    expect(bloomPrefilterCpuReference(test, "native-max-rgb")[0]).toBeCloseTo(.000002, 10);
  });
  it("keeps zero-threshold identity and HDR proportional extraction", () => {
    for (const profile of ["ts-max-rgb", "native-max-rgb"] as const) {
      expect(bloomPrefilterCpuReference({ id: "zero", color: [.25, -.1, .125], threshold: 0, softKnee: 0 }, profile))
        .toEqual([.25, 0, .125]);
      expect(bloomPrefilterCpuReference({ id: "hdr", color: [64, 8, 2], threshold: 4, softKnee: .75 }, profile))
        .toEqual([60, 7.5, 1.875]);
    }
  });
});
