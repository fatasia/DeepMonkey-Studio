// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/brdfDirectMultiscattering.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/lighting/brdfDirectMultiscatteringWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍;无 Rust 半,纯 TS 消费)。


export const PBR_BRDF_DIRECT_MULTISCATTERING_WGSL = /* wgsl */ "// Direct GGX energy compensation; DFG sampling stays in each host.\nfn deepDirectMultiscatteringEnergy(f0: vec3f, dfgView: vec2f, dfgLight: vec2f) -> vec3f {\n  let singleView = f0 * dfgView.x + dfgView.y;\n  let singleLight = f0 * dfgLight.x + dfgLight.y;\n  let lostView = 1.0 - (dfgView.x + dfgView.y);\n  let lostLight = 1.0 - (dfgLight.x + dfgLight.y);\n  let averageFresnel = f0 + (1.0 - f0) * 0.047619;\n  let multiple = singleView * singleLight * averageFresnel\n    / (1.0 - lostView * lostLight * averageFresnel + 0.000001);\n  return multiple * (lostView * lostLight);\n}\n";
