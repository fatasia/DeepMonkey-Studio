import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import source from "../../wgsl/fogOpticalDepth.wgsl?raw";
import pinned from "../../wgsl/fogOpticalDepth.wgsl.sha256?raw";
import { FOG_OPTICAL_DEPTH_WGSL } from "./fogOpticalDepthWgsl.js";
import { VOLUMETRIC_FOG_MARCH_WGSL } from "./volumetricFogPassWgsl.js";
import { PBR_FOG_WGSL } from "../webgpu/pbrFogWgsl.js";

describe("shared fog optical-depth math", () => {
  it("keeps the canonical identity and generated mirror exact", () => {
    expect(FOG_OPTICAL_DEPTH_WGSL).toBe(source);
    const [hash, bytes] = pinned.trim().split(/\s+/);
    expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
    expect(new TextEncoder().encode(source).length).toBe(Number(bytes));
  });

  it("is consumed once by the real PBR and volumetric compute shaders", () => {
    for (const shader of [PBR_FOG_WGSL, VOLUMETRIC_FOG_MARCH_WGSL]) {
      expect(shader).toContain(source);
      for (const name of ["deepFogDensityAtHeight", "deepFogTransmittance"]) {
        expect(shader.split(`fn ${name}(`)).toHaveLength(2);
      }
    }
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("deepFogDensityAtHeight(height, baseExtinction, scaleHeight)");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("let extinction = deepFogTransmittance(opticalDepth)");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("albedo * opticalDepth * phase * 1.0");
    expect(PBR_FOG_WGSL).toContain("deepFogTransmittance(opticalDepth * opticalDepth)");
    expect(PBR_FOG_WGSL).toContain("transmittance *= deepFogTransmittance(stepDepth)");
  });

  it("preserves Native world-height/profile policy and assembles the actual factory", () => {
    const host = readFileSync(new URL("../../../deep-engine-native/src/output_pass.rs", import.meta.url), "utf8");
    expect(host).toContain('include_str!("../../deep-engine/wgsl/fogOpticalDepth.wgsl")');
    expect(host).toContain('[FOG_OPTICAL_DEPTH_SHADER, variant].join("\\n")');
    for (const name of ["native_output_fog_v1", "native_output_bloom_fog_v1"]) {
      const body = readFileSync(new URL(`../../../deep-engine-native/assets/shaders/${name}.wgsl`, import.meta.url), "utf8");
      expect(body).toContain("deepFogDensityAtHeight(sample_height, frame.tuning.w, frame.fogProfile.y)");
      expect(body).toContain("deepFogTransmittance(density * step_distance)");
      expect(body).toContain("sample_height = frame.eye.y + ray.y * sample_distance");
      expect(body).toContain("0.0, 4.0");
      expect(body).toContain("frame.fogProjection.z == 2.0");
    }
  });
});
