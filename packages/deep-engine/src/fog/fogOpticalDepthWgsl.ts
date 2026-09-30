// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/fogOpticalDepth.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/fog/fogOpticalDepthWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/src/output_pass.rs(include_str! 引用同一文件,共用同一夹具)。


export const FOG_OPTICAL_DEPTH_WGSL = /* wgsl */ "fn deepFogDensityAtHeight(height: f32, baseExtinction: f32, scaleHeight: f32) -> f32 {\n  return baseExtinction * exp(-max(height, 0.0) / scaleHeight);\n}\nfn deepFogTransmittance(opticalDepth: f32) -> f32 {\n  return exp(-opticalDepth);\n}\n";
