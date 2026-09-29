// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/brdfDirectLighting.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/lighting/brdfDirectLightingWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/src/lighting_math_wgsl.rs(include_str! 引用同一文件,共用同一夹具)。

/**
 * J2-B1 直射 BRDF 家族的生成镜像。唯一真源 wgsl/brdfDirectLighting.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费)。高光乘法次序 `f * visibility * distribution` 是 TS 权威序
 * (白炉验收基准;native 原实现为 distribution 起乘,B1 已对齐,漂移记录见任务报告)。
 */
export const PBR_BRDF_DIRECT_LIGHTING_WGSL = /* wgsl */ "fn fresnel(cosine: f32, f0: vec3f) -> vec3f {\n  let factor = exp2((-5.55473 * cosine - 6.98316) * cosine);\n  return f0 * (1.0 - factor) + factor;\n}\nfn deepGeometryRoughness(normal: vec3f) -> f32 {\n  let derivative = max(abs(dpdx(normal)), abs(dpdy(normal)));\n  return max(max(derivative.x, derivative.y), derivative.z);\n}\nfn brdfWithDielectricF0(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32, dielectric: f32) -> vec3f {\n  let h = safeNormalize(v + l, n); let nv = clamp(dot(n, v), 0.0001, 1.0); let nl = clamp(dot(n, l), 0.0, 1.0);\n  let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);\n  let alpha = rough * rough; let a2 = alpha * alpha; let denom = nh * nh * (a2 - 1.0) + 1.0;\n  let distribution = a2 / max(3.14159265 * denom * denom, 0.000001);\n  let gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv);\n  let gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);\n  let visibility = 0.5 / max(gv + gl, 0.000001);\n  let f0 = mix(vec3f(dielectric), base, metal); let f = fresnel(vh, f0);\n  let specular = f * visibility * distribution;\n  let diffuse = (1.0 - metal) * base / 3.14159265;\n  return (diffuse + specular) * nl;\n}\nfn brdf(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32) -> vec3f {\n  return brdfWithDielectricF0(n, v, l, base, metal, rough, 0.04);\n}\n";
