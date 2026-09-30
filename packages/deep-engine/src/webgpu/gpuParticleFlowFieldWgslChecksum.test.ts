import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GPU_PARTICLE_FLOW_FIELD_WGSL, GPU_PARTICLE_FLOW_UNIFORM_BYTES, GPU_PARTICLE_FLOW_ENTRY } from "./gpuParticleFlowFieldWgsl.js";
import { GPU_PARTICLE_COMPUTE_WGSL } from "./gpuParticleWgsl.js";
describe("particle flow single source", () => {
  it("pins canonical bytes and ABI", () => {
    const source = readFileSync(new URL("../../wgsl/particleFlowField.wgsl", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const [digest, bytes] = readFileSync(new URL("../../wgsl/particleFlowField.wgsl.sha256", import.meta.url), "utf8").trim().split(/\s+/);
    expect(GPU_PARTICLE_FLOW_FIELD_WGSL).toBe(source);
    expect(createHash("sha256").update(source).digest("hex")).toBe(digest);
    expect(Buffer.byteLength(source)).toBe(Number(bytes));
    expect(GPU_PARTICLE_FLOW_UNIFORM_BYTES).toBe(32);
    expect(source).toContain(`fn ${GPU_PARTICLE_FLOW_ENTRY}(`);
  });
  it("retains base binding declarations, lifetime, wrap and compaction guards", () => {
    const bindings = GPU_PARTICLE_COMPUTE_WGSL.match(/@group\(0\) @binding\([0-5]\).*;/g)!;
    for (const line of bindings) expect(GPU_PARTICLE_FLOW_FIELD_WGSL).toContain(line);
    for (const line of ["if (age >= lifetime && !looping) { return; }", "let cycles = floor(age / lifetime);",
      "let destination = atomicAdd(&outputCounter.value, 1u);",
      "if (destination < frame.capacity) { outputParticles[destination] = particle; }"]) {
      expect(GPU_PARTICLE_COMPUTE_WGSL).toContain(line); expect(GPU_PARTICLE_FLOW_FIELD_WGSL).toContain(line);
    }
  });
});
