// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/bloomPrefilter.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/postprocess/bloomPrefilterWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/src/bloom_pass.rs(include_str! 引用同一文件,共用同一夹具)。


export const BLOOM_PREFILTER_WGSL = /* wgsl */ "// max-RGB soft-knee arithmetic; sampling and knee/epsilon policy belong to each host.\nfn deepBloomSoftKnee(brightness: f32, threshold: f32, knee: f32, denominatorBias: f32) -> f32 {\n  let transition = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);\n  return transition * transition / (4.0 * knee + denominatorBias);\n}\n\nfn deepBloomContribution(brightness: f32, threshold: f32, soft: f32) -> f32 {\n  return max(brightness - threshold, soft) / max(brightness, 0.00001);\n}\n";
