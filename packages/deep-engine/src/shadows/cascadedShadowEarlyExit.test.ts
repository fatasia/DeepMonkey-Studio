import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CASCADED_SHADOW_WGSL } from "./cascadedShadowShader.js";
import { DEEP_PACKAGE_CSM_WGSL } from "../shaderAuthoring/packageAdapterCsm.js";

const native = readFileSync(new URL("../../../deep-engine-native/assets/shaders/native_cascaded_shadow_v1.wgsl", import.meta.url), "utf8");
const entries = [
  { id: "built-in", source: CASCADED_SHADOW_WGSL, functionName: "deepCascadedShadow", sample: "deepSampleCascade", start: "blendStart", depth: "viewDepth" },
  { id: "DeepSL package", source: DEEP_PACKAGE_CSM_WGSL, functionName: "deepShadowVisibility", sample: "deepSampleCascade", start: "blendStart", depth: "viewDepth" },
  { id: "native", source: native, functionName: "shadow_visibility", sample: "sample_cascade", start: "blend_start", depth: "view_depth" },
];

it.each(entries)("$id rejects degenerate blending and returns before next-cascade PCF outside the blend interval", entry => {
  const body = entry.source.slice(entry.source.indexOf(`fn ${entry.functionName}(`)).split("\nfn ")[0]!;
  const lastCascade = body.indexOf("if (index + 1u >= count) { return current; }");
  const guard = body.indexOf(`if (${entry.start} >= split || ${entry.depth} <= ${entry.start}) { return current; }`);
  const nextSample = body.indexOf(`${entry.sample}(index + 1u`);
  const smoothing = body.indexOf("smoothstep(");
  expect(lastCascade).toBeGreaterThan(0);
  expect(guard).toBeGreaterThan(lastCascade);
  expect(nextSample).toBeGreaterThan(guard);
  expect(smoothing).toBeGreaterThan(guard);
  expect(body).not.toContain(`${entry.depth} >= split`);
});
