// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/cascadedShadowMath.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/shadows/cascadedShadowMathWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/src/frame_bindings.rs(include_str! 引用同一文件,共用同一夹具)。


export const CASCADED_SHADOW_MATH_WGSL = /* wgsl */ "// Binding-free CSM blending; last-cascade selection stays with each host.\nfn deepCascadeBlendInactive(viewDepth: f32, blendStart: f32, split: f32) -> bool {\n  return blendStart >= split || viewDepth <= blendStart;\n}\n\n// Call only after the inactive guard, so the smoothstep interval has positive width.\nfn deepCascadeBlendWeight(viewDepth: f32, blendStart: f32, split: f32) -> f32 {\n  return smoothstep(blendStart, split, viewDepth);\n}\n";
