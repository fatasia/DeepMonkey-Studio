// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/materialDielectric.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/lighting/materialDielectricWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/src/lighting_math_wgsl.rs(include_str! 引用同一文件,共用同一夹具)。

/**
 * J2-B1 介电 F0 家族(灯光数学三件套之一)的生成镜像。唯一真源 wgsl/materialDielectric.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费)。再导出入口:src/materialDielectric.ts(既有 import 路径不变)。
 */
export const MATERIAL_DIELECTRIC_WGSL = /* wgsl */ "\nfn deepDielectricF0(encodedIor: f32) -> f32 {\n  if (encodedIor == 0.0 || encodedIor == 1.5) { return 0.04; }\n  let reflectance = 1.0 - 2.0 / (encodedIor + 1.0);\n  return reflectance * reflectance;\n}\n";
