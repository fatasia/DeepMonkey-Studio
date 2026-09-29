// J2-B1 一次性提取器(临时):从现有 TS 导出串机械切片出三家族 WGSL 真源,
// 避免手抄引入字节误差。跑一次后删除;后续唯一真源是 wgsl/ 下三份文件。
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";
import { MATERIAL_DIELECTRIC_WGSL } from "../src/materialDielectric.js";
import { PBR_DIRECT_LIGHTING_WGSL } from "../src/webgpu/pbrDirectLightingWgsl.js";
import { FORWARD_PLUS_PBR_WGSL } from "../src/lighting/clusterLightingPbrWgsl.js";

const wgslRoot = resolve(import.meta.dirname, "../wgsl");

it("extracts the three lighting-math families byte-exactly", () => {
  // 介电 F0:MATERIAL_DIELECTRIC_WGSL 全文(含模板首行换行,字节冻结)。
  writeFileSync(resolve(wgslRoot, "materialDielectric.wgsl"), MATERIAL_DIELECTRIC_WGSL, "utf8");
  // 直射 BRDF:PBR_DIRECT_LIGHTING_WGSL 去掉首行换行与介电块后的余部(以 fn fresnel 起,以 }\\n 止)。
  const brdfStart = PBR_DIRECT_LIGHTING_WGSL.indexOf("fn fresnel");
  if (brdfStart < 0) throw new Error("fresnel not found");
  writeFileSync(resolve(wgslRoot, "brdfDirectLighting.wgsl"), PBR_DIRECT_LIGHTING_WGSL.slice(brdfStart), "utf8");
  // IES 采样:FORWARD_PLUS_PBR_WGSL 中 DEEP_IES 常量起、deepClusterSafeNormalize 前止
  // (常量+合同注释+deepSpotIesFactor;插值 ${IES_TABLE_ROW_STRIDE_VEC4}u 已固化为 91u 字面量)。
  const iesStart = FORWARD_PLUS_PBR_WGSL.indexOf("const DEEP_IES_RAD_TO_DEG");
  const iesEnd = FORWARD_PLUS_PBR_WGSL.indexOf("fn deepClusterSafeNormalize");
  if (iesStart < 0 || iesEnd < 0 || iesEnd <= iesStart) throw new Error("ies region not found");
  writeFileSync(resolve(wgslRoot, "iesSampling.wgsl"), FORWARD_PLUS_PBR_WGSL.slice(iesStart, iesEnd), "utf8");
});
