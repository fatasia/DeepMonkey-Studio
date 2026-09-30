import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import source from "../../wgsl/bloomPrefilter.wgsl?raw";
import pinned from "../../wgsl/bloomPrefilter.wgsl.sha256?raw";
import { BLOOM_PREFILTER_WGSL } from "./bloomPrefilterWgsl.js";
import { BLOOM_WGSL } from "./bloomWgsl.js";

describe("shared max-RGB bloom prefilter", () => {
  it("keeps the generated mirror and pinned source identity exact", () => {
    expect(BLOOM_PREFILTER_WGSL).toBe(source);
    const [hash, size] = pinned.trim().split(/\s+/);
    const bytes = new TextEncoder().encode(source);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
    expect(bytes.length).toBe(Number(size));
  });

  it("is consumed once by the production compute shader with the original zero-knee policy", () => {
    expect(BLOOM_WGSL).toContain(source);
    for (const name of ["deepBloomSoftKnee", "deepBloomContribution"]) {
      expect(BLOOM_WGSL.split(`fn ${name}(`)).toHaveLength(2);
    }
    expect(BLOOM_WGSL).toContain("let knee = bloomParams.threshold * bloomParams.softKnee");
    expect(BLOOM_WGSL).toContain("if (knee > 0.0)");
    expect(BLOOM_WGSL).toContain("deepBloomSoftKnee(brightness, bloomParams.threshold, knee, 0.0)");
    expect(BLOOM_WGSL).toContain("return positive * contribution");
  });

  it("preserves Native floor/bias and leaves author-luminance bloom independent", () => {
    const native = readFileSync(new URL("../../../deep-engine-native/assets/shaders/native_bloom_v1.wgsl", import.meta.url), "utf8");
    const host = readFileSync(new URL("../../../deep-engine-native/src/bloom_pass.rs", import.meta.url), "utf8");
    const author = readFileSync(new URL("./authorBloomWgsl.ts", import.meta.url), "utf8");
    expect(native).toContain("max(bloom.threshold * bloom.soft_knee, 0.00001)");
    expect(native).toContain("deepBloomSoftKnee(brightness, bloom.threshold, knee, 0.00001)");
    expect(host).toContain('include_str!("../../deep-engine/wgsl/bloomPrefilter.wgsl")');
    expect(host).toContain("bloom_shader().into()");
    expect(author).not.toContain("BLOOM_PREFILTER_WGSL");
    expect(author).toContain("settings.threshold + 0.01");
  });
});
