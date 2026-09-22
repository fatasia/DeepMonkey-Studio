import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { averageAmbientSamples, AMBIENT_WGSL } from "./environmentAmbientReader.js";

describe("environment ambient reader", () => {
  it("averages the rgb lanes of all 384 samples and keeps the mean exact", () => {
    const samples = new Float32Array(384 * 4);
    for (let index = 0; index < 384; index++) samples.set([1, 2, 3, 0], index * 4);
    expect([...averageAmbientSamples(samples)]).toEqual([1, 2, 3]);
  });

  it("rejects truncated sample buffers instead of averaging a partial read", () => {
    expect(() => averageAmbientSamples(new Float32Array(384 * 4 - 4))).toThrow(/truncated/);
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-environment-ambient.wgsl", "--input-kind", "wgsl"],
      { input: AMBIENT_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Validation successful");
  });
});
