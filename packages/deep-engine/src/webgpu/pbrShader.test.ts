import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { currentToPreviousUvMotion, outputShader, sceneShader } from "./pbrShader.js";
import { PBR_DIRECT_LIGHTING_WGSL } from "./pbrDirectLightingWgsl.js";

describe("normal-map WGSL contract", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-pbr.wgsl", "--input-kind", "wgsl"],
      { input: sceneShader, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("emits AO/TAA geometry attachments with exact static motion", () => {
    expect(sceneShader).toContain("@location(0) color: vec4f, @location(1) viewDepth: f32");
    expect(sceneShader).toContain("@location(2) viewNormal: vec4f, @location(3) motion: vec2f");
    expect(sceneShader).toContain("frame.previousViewProjection * vec4f(previousWorld, 1.0)");
    expect(sceneShader).toContain("max(-(frame.worldToView * vec4f(out.world, 1.0)).z, 0.0)");
    expect(sceneShader).toContain("clipUv(v.previousClip) - clipUv(v.currentClip) - projectionJitterDeltaUv");
    expect(currentToPreviousUvMotion([2, -1, 0.5, 4], [2, -1, 0.5, 4])).toEqual([0, 0]);
    expect(currentToPreviousUvMotion([0, 0, 0, 1], [1, 1, 0, 2])).toEqual([0.25, -0.25]);
    expect(currentToPreviousUvMotion([.25, 0, 0, 1], [-.25, 0, 0, 1], [-.25, 0])).toEqual([0, 0]);
  });

  it("keeps display output to tone mapping after the dedicated bloom pass", () => {
    expect(outputShader).not.toContain("for (var y = -1; y <= 1; y++)");
    expect(outputShader).not.toContain("settings.bloom / 9.0");
    expect(outputShader.indexOf("color *= toneExposure")).toBeLessThan(outputShader.indexOf("color = deepApplyColorGrading(color"));
    expect(outputShader.indexOf("color = deepApplyColorGrading(color")).toBeLessThan(outputShader.indexOf("deepThreeAcesFit(color, toneExposure)"));
    expect(outputShader.match(/deepLinearToSrgb\(color\)/g)).toHaveLength(1);
    expect(outputShader.match(/textureSample\(/g)).toHaveLength(1);
  });
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates the display output with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-pbr-output.wgsl", "--input-kind", "wgsl"],
      { input: outputShader, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("writes weighted OIT accumulation and revealage for transparent materials", () => {
    expect(sceneShader).toContain("struct DeepWeightedOitOutput");
    // DE26/C03:两个透明入口按材质 flags bit128 在 straight 与 premultiplied 累积之间选择。
    const dispatch = "return select(deepWeightedOit(color, alpha, depth), deepWeightedOitPremultiplied(color, alpha, depth), flag(v.material.w, 128u))";
    expect(sceneShader.match(new RegExp(dispatch.replace(/[()]/g, "\\$&"), "g"))).toHaveLength(2);
    expect(sceneShader).toContain("let alpha = coverage(v.emissiveAlpha.w, v.material)");
    expect(sceneShader).toContain("let alpha = coverage(surface.alpha, v.material)");
    expect(sceneShader).toContain("let depth = clamp(v.clip.z, 0.0, 1.0)");
    expect(sceneShader).not.toContain("v.clip.z / max(v.clip.w");
  });
  it("uses the Forward+ group for fill lights in every material path", () => {
    expect(sceneShader).toContain("deepForwardPlusPbrWorldReceiving(fragmentCoordinate, world, n, frame.worldToView");
    expect(sceneShader).toContain("deepClusterParams.limits.z > 0u || deepClusterParams.grid1.w > 0u");
    expect(sceneShader).not.toContain("safeNormalize(vec3f(-0.8, 0.4, -0.6)");
    expect(sceneShader.match(/shade\(v\.clip\.xy/g)).toHaveLength(8);
    expect(sceneShader).toContain("@fragment fn fragmentMainColor");
    expect(sceneShader).toContain("@fragment fn fragmentMaterialColor");
    expect(sceneShader).toContain("@fragment fn fragmentMainDisplay");
    expect(sceneShader).toContain("@fragment fn fragmentMaterialDisplay");
  });

  it("branches around disabled environment, fog and ground-grid work", () => {
    expect(sceneShader).toContain("if (frame.floor.w > 0.0)");
    expect(sceneShader).toContain("if (frame.eye.w > 0.0)");
    expect(sceneShader).toContain("if (frame.tuning.w <= 0.0) { return color; }");
  });

  it("takes primary directional radiance from the frame instead of a baked studio constant", () => {
    expect(sceneShader).toContain("sunColor: vec4f");
    expect(sceneShader).toContain("frame.sunColor.rgb * frame.sunColor.w * visibility");
    expect(sceneShader).not.toContain("vec3f(2.5, 2.4, 2.25) * visibility");
  });
  it("keeps direct diffuse separate from view-dependent Fresnel without extra texture samples", () => {
    expect(sceneShader).toContain("let visibility = 0.5 / max(gv + gl, 0.000001)");
    expect(PBR_DIRECT_LIGHTING_WGSL).not.toContain("textureSample");
    expect(sceneShader).toContain("let diffuse = (1.0 - metal) * base / 3.14159265");
    expect(PBR_DIRECT_LIGHTING_WGSL).not.toContain("(1.0 - f) * (1.0 - metal) * base");
  });
  it("raises roughness from screen-space normal derivatives to suppress specular aliasing", () => {
    expect(PBR_DIRECT_LIGHTING_WGSL).toContain("max(abs(dpdx(normal)), abs(dpdy(normal)))");
    expect(sceneShader.match(/\+ deepGeometryRoughness\(n\)/g)).toHaveLength(4);
    expect(sceneShader).toContain("let rough = min(1.0");
  });
  it("uses four blended cascades for the default directional shadow", () => {
    expect(sceneShader).toContain("@group(2) @binding(1) var deepShadowMap: texture_depth_2d_array");
    expect(sceneShader).toContain("textureSampleCompareLevel(deepShadowMap, deepShadowSampler");
    expect(sceneShader).toContain("if (viewDepth > lastSplit) { return 1.0; }");
    expect(sceneShader).toContain("let slopeBias = 1.0 - clamp(nDotL, 0.0, 1.0);");
    expect(sceneShader).toContain("let receiverPosition = worldPosition + worldNormal * texelWorld * normalBias;");
    expect(sceneShader).toContain("let visibility = deepPrimaryShadow(world, n, dot(n, l), authorShadow");
    expect(sceneShader).toContain("return deepCascadedShadow(max(");
    expect(sceneShader).toContain("deepSampleCascade(index + 1u, worldPosition, worldNormal, nDotL), blend)");
  });
  it("keeps degenerate lighting and tangent vectors finite", () => {
    expect(sceneShader).toContain("fn safeNormalize(value: vec3f, fallback: vec3f)");
    expect(sceneShader).toContain("let h = safeNormalize(v + l, n)");
    expect(sceneShader).toContain("safeNormalize(frame.eye.xyz - world");
    expect(sceneShader).toContain("safeNormalize(v.tangent.xyz - n * dot(n, v.tangent.xyz), tangentFallback(n))");
    expect(sceneShader).toContain("return safeNormalize(tangent * tangentNormal.x");
    expect(sceneShader).toContain("let nv = clamp(dot(n, v), 0.0001, 1.0)");
    expect(sceneShader).toContain("let vh = clamp(dot(v, h), 0.0, 1.0)");
  });

  it("guards optional texture samples with per-material uniform flags", () => {
    expect(sceneShader).toContain("if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal");
    expect(sceneShader).toContain("if (materialTextures.occlusionRow0.w > 0.5)");
    expect(sceneShader).toContain("if (materialTextures.emissiveRow0.w > 0.5)");
  });

  it("selects UV0 or UV1 independently for every material slot and masked shadow", () => {
    expect(sceneShader).toContain("@location(10) uvSets: vec4f");
    expect(sceneShader).toContain("@location(15) row2: vec4f");
    expect(sceneShader).toContain("fn slotUv(uv0: vec2f, uv1: vec2f");
    expect(sceneShader).toContain("select(uv0, uv1, row0.w > 1.5)");
    for (const slot of ["base", "mr", "occlusion", "emissive", "normal"]) {
      expect(sceneShader).toContain(`slotUv(v.uv0, v.uv1, materialTextures.${slot}Row0, materialTextures.${slot}Row1)`);
    }
    expect(sceneShader).toContain("select(v.uv0, v.uv1, materialTextures.baseRow0.w > 1.5)");
  });

  it("builds world TBN with inverse-transpose normals, model tangents and mirror handedness", () => {
    expect(sceneShader).toContain("mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal");
    expect(sceneShader).toContain("dot(v.row0.xyz, v.tangent.xyz)");
    expect(sceneShader).toContain("v.tangent.w * v.material.z");
    expect(sceneShader).toContain("sourceBitangent = cross(n, sourceTangent) * v.tangent.w");
  });

  it("applies the normal UV transform basis, glTF scale and linear RGB unpacking", () => {
    expect(sceneShader).toContain("materialTextures.normalRow0.x * materialTextures.normalRow1.y - materialTextures.normalRow0.y * materialTextures.normalRow1.x");
    expect(sceneShader).toContain("textureSample(normalMap, normalSampler, normalUv).rgb * 2.0 - 1.0");
    expect(sceneShader).toContain("sampled.xy * materialTextures.normalRow1.w");
    expect(sceneShader).toContain("tangent * tangentNormal.x + bitangent * tangentNormal.y + n * tangentNormal.z");
  });

  it("samples AO from linear R and applies strength only to indirect lighting", () => {
    expect(sceneShader).toContain("textureSample(occlusionMap, occlusionSampler, aoUv).r");
    expect(sceneShader).toContain("1.0 + materialTextures.occlusionRow1.w * (sampled - 1.0)");
    expect(sceneShader).toContain("base * irradiance * occlusion");
    expect(sceneShader).toContain("energyCompensation * occlusion");
    expect(sceneShader).toContain("textureNumLevels(specularEnvironment) - 1u");
  });

  it("adds sRGB-sampled emissive in linear HDR before fog/output tone mapping", () => {
    expect(sceneShader).toContain("textureSample(emissiveMap, emissiveSampler, emissiveUv).rgb");
    expect(sceneShader).toContain("v.emissiveAlpha.rgb * emission * materialTextures.emissiveRow1.w");
    expect(sceneShader).toContain("surface.emissive");
    expect(sceneShader.indexOf("color += select(emissive")).toBeLessThan(sceneShader.indexOf("return mix(color, frame.background"));
  });

  it("uses the same factor-times-texture cutoff in color and masked shadows", () => {
    expect(sceneShader).toContain("flag(material.w, 2u) && alpha < material.y");
    expect(sceneShader).toContain("v.alphaCutoff.x * sampledAlpha < v.alphaCutoff.y");
    expect(sceneShader).toContain("select(1.0, alpha, flag(material.w, 4u))");
  });

  it("reverses double-sided back-face normals after accounting for mirrored instances", () => {
    expect(sceneShader).toContain("@builtin(front_facing) frontFacing: bool");
    expect(sceneShader).toContain("select(!frontFacing, frontFacing, material.z > 0.0)");
    expect(sceneShader).toContain("flag(material.w, 1u) && !gltfFront");
    expect(sceneShader).toContain("select(normalInput, -normalInput, reverseBackFace)");
  });
});
