// I 级 C23 分层材质混合核家族的 TS 半字节门禁(形态照抄 materialDielectricWgslChecksum.test.ts):
// 1) 生成镜像不陈旧:导出串与真源 wgsl/materialLayerBlend.wgsl 逐字节一致;
// 2) 跨宿主对拍:TS 宿主拿到的字节 SHA-256 与共享夹具 .sha256(<hex> <byteLen>)一致
//    (本家族无 Rust 半,纯 TS 消费;夹具仍是双端合同锚点);
// 3) 家族合同锁定:混合闭式与 CPU 参考 materialLayeredEvaluate.blendChannel 逐运算镜像、
//    常量与 materialLayeredParameters.ts 互钉、纯函数库(无入口)、deepLayer 命名隔离。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/materialLayerBlend.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/materialLayerBlend.wgsl?raw";
import { MATERIAL_LAYER_BLEND_WGSL } from "./materialLayerBlendWgsl.js";
import { MATERIAL_LAYER_BLEND_MODE_CODES, MATERIAL_LAYER_FLOAT_COUNT,
  MATERIAL_LAYER_MAX_COUNT, LAYERED_MATERIAL_FLOAT_COUNT } from "./materialLayeredParameters.js";
import { DEEP_LAYER_BLEND_MODE_OVERLAY, DEEP_LAYER_BLEND_MODE_REPLACE, DEEP_LAYER_MAX_COUNT,
  DEEP_LAYER_SLOT_FLOAT_COUNT, DEEP_LAYERED_BLOCK_FLOAT_COUNT } from "./materialLayerBlendWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("material layer blend WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(MATERIAL_LAYER_BLEND_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(MATERIAL_LAYER_BLEND_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the blend closed forms in exact lockstep with the CPU reference", () => {
    // 共享权重结构:w 只由层 rgb 派生,同一 w 施加于 rgb 与全部 lobe —— 分量分解不被破坏。
    expect(MATERIAL_LAYER_BLEND_WGSL).toContain("let weightLayer = coverage;");
    expect(MATERIAL_LAYER_BLEND_WGSL).toContain(
      "let weightLayer = coverage * clamp(layerRgb, vec3f(0.0), vec3f(1.0));");
    expect(MATERIAL_LAYER_BLEND_WGSL).toContain("return (1.0 - weightLayer) * underlying + weightLayer * layer;");
    // mode 分发与打包码互钉(0=replace,1=overlay)。
    expect(MATERIAL_LAYER_BLEND_WGSL).toContain("mode == DEEP_LAYER_BLEND_MODE_REPLACE");
  });

  it("pins the ABI constants against materialLayeredParameters", () => {
    expect(DEEP_LAYER_BLEND_MODE_REPLACE).toBe(MATERIAL_LAYER_BLEND_MODE_CODES.replace);
    expect(DEEP_LAYER_BLEND_MODE_OVERLAY).toBe(MATERIAL_LAYER_BLEND_MODE_CODES.overlay);
    expect(DEEP_LAYER_MAX_COUNT).toBe(MATERIAL_LAYER_MAX_COUNT);
    expect(DEEP_LAYER_SLOT_FLOAT_COUNT).toBe(MATERIAL_LAYER_FLOAT_COUNT);
    expect(DEEP_LAYERED_BLOCK_FLOAT_COUNT).toBe(LAYERED_MATERIAL_FLOAT_COUNT);
  });

  it("is a pure library: no entry points and deepLayer-prefixed functions only", () => {
    expect(MATERIAL_LAYER_BLEND_WGSL).not.toContain("@compute");
    expect(MATERIAL_LAYER_BLEND_WGSL).not.toContain("@vertex");
    expect(MATERIAL_LAYER_BLEND_WGSL).not.toContain("@fragment");
    const names = [...MATERIAL_LAYER_BLEND_WGSL.matchAll(/^fn (\w+)/gmu)].map((match) => match[1]!);
    expect(names).toEqual(["deepLayerBlendReplace", "deepLayerBlendOverlay", "deepLayerBlend"]);
    expect(MATERIAL_LAYER_BLEND_WGSL).not.toContain("deepMaterialEvaluate");
    expect(MATERIAL_LAYER_BLEND_WGSL).not.toContain("deepSafeNormalize");
  });
});
