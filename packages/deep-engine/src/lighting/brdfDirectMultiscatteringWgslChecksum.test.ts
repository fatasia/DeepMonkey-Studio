import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import source from "../../wgsl/brdfDirectMultiscattering.wgsl?raw";
import checksum from "../../wgsl/brdfDirectMultiscattering.wgsl.sha256?raw";
import { PBR_BRDF_DIRECT_MULTISCATTERING_WGSL as mirror } from "./brdfDirectMultiscatteringWgsl.js";
import { sceneShader } from "../webgpu/pbrShader.js";

it("the direct energy kernel is the registered canonical bytes and occurs once in the production module", () => {
  const bytes = new TextEncoder().encode(source), [hash, size] = checksum.trim().split(/\s+/);
  expect(mirror).toBe(source); expect(bytes.length).toBe(Number(size));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  expect(sceneShader.split("fn deepDirectMultiscatteringEnergy(")).toHaveLength(2);
});
it("HDR and both direct presentation hosts consume the same energy kernel without new bindings", () => {
  expect(sceneShader.match(/deepDirectMultiscatteringFromView\(n, l, base, metal, rough, dielectric, dfg\)/g)).toHaveLength(1);
  expect(sceneShader.match(/deepSampleDirectMultiscattering\(n, view, l, base, metal, rough, dielectric\)/g)).toHaveLength(2);
  expect(mirror).not.toContain("@group"); expect(mirror).not.toContain("textureSample");
});
