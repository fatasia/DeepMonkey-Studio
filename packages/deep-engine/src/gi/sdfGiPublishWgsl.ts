// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/sdfGiPublish.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/gi/sdfGiPublishWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍;无 Rust 半,纯 TS 消费)。

/**
 * Brief-GI M3 探针消费物化核的生成镜像。唯一真源 wgsl/sdfGiPublish.wgsl,
 * 纯 TS 消费(无 Rust 半)。常量与 sdfGiPublish.ts(发布资源/打包)互钉。
 */

/** workgroup 尺寸:每 lane 独立物化一个探针格 cell,无跨 lane 通信。 */
export const SDF_GI_PUBLISH_WORKGROUP_SIZE = 64;
/** PublishParams uniform 总字节(vec3u@0(对齐16)+3×u32 → struct 尺寸 32B;
 * Chrome 按 struct 全长取 minBindingSize,16 会在真机 CreateComputePipeline 处爆)。 */
export const SDF_GI_PUBLISH_PARAMS_BYTES = 32;
/** compute 入口名(运行时与测试按名取 entry point)。 */
export const SDF_GI_PUBLISH_ENTRY = "sdfGiPublishMain";
/** 96B 记录 ABI 的 vec4 步长(与 sdfGiProbeUpdateWgsl 互钉)。 */
export const SDF_GI_PUBLISH_RECORD_VEC4_STRIDE = 6;

/** 探针消费物化核:96B 记录 → 主 pass 探针 clipmap 采样纹理(真源 wgsl/sdfGiPublish.wgsl)。 */
export const DEEP_SDF_GI_PUBLISH_WGSL = /* wgsl */ "// Brief-GI M3 探针消费物化核(2026-10-05):把 96B IrradianceProbeRecord 探针场物化为\n// 主 pass 探针 clipmap 采样纹理(probeClipmapTextureSampling 的 group3 纹理 ABI),让\n// pbrShader shade() 的 ambient 项 mix(environmentIrradiance, gi.rgb, gi.a) 真实消费\n// SDF GI 探针记录(消费接线切片:此前 dispatch 链已达标但探针记录无主 pass 消费)。\n//\n// == texel 布局合同(与 F5 capture 侧逐字对齐;偏差即主 pass 采样错位)==\n// - deepGiVolume(texture_2d_array rgba16float):宽=dx、高=dy、层数=dz;\n//   texel(cell.xy, layer=cell.z) = (irradiance.rgb, validity) —— record vec4[0] 透传。\n// - deepGiMoments(texture_2d_array rgba32float):同一宽高,层数 = dz×4 lanes;\n//   lane 层 = cell.z×4 + lane;lane0 = (meanDistance, variance, missRatio, valid) =\n//   record vec4[1].xyz 透传 + valid=1(moments 在场);lane1..3 = F5 words[12..23]\n//   RGB L1 SH —— **恒写零**(SH 缺失合同,specular 门走标量 fallback;本核绝不合成 SH)。\n// - 采样端 realMoments 判据 = moments 2D 尺寸 == level gridSize.xy 且\n//   layers >= (level+1)×dz×4;本核输出恰好满足(单层 level=0)。\n//\n// == 确定性(与 sdfGiProbeUpdate/sdfSkyVisibilityTrace 同族)==\n// 每 lane 独立读写一个探针格 cell 的 texel:无跨 lane 通信、无 workgroup 内存、无原子,\n// 同输入同 dispatch 逐位回放;lane ≥ probeCount 早退。记录值透传不重算(烘焙/更新核\n// 已保证有限;rgba16float 量化是写后精度,不是本核注入误差)。\n\nstruct PublishParams {\n  /** 探针格分辨率(x,y,z;z 为纹理层数轴)。 */\n  dimensions: vec3u,\n  /** 探针总数 = dx×dy×dz(lane 越界早退线)。 */\n  probeCount: u32,\n  /** 96B 记录 ABI 的 vec4 步长(=6;漂移即 ABI 破坏,与打包侧互钉)。 */\n  recordVec4Stride: u32,\n  /** moments lane 数(F5 合同 = 4;与 probeClipmapTextureSampling 判据互钉)。 */\n  momentLanes: u32,\n};\n\n@group(0) @binding(0) var<uniform> params: PublishParams;\n// 探针记录存储(vec4[6]/探针,96B IrradianceProbeRecord ABI;sdfGiProbeUpdate 的输出)。\n@group(0) @binding(1) var<storage, read> records: array<vec4f>;\n// 主 pass deepGiSampleTexture 的辐照体积(storage 写视图;rgba16float = F5 capture 同格式)。\n@group(0) @binding(2) var deepGiVolume: texture_storage_2d_array<rgba16float, write>;\n// 主 pass 可见性/SH moments(lane 扩容体积;rgba32float = F5 capture 同格式)。\n@group(0) @binding(3) var deepGiMoments: texture_storage_2d_array<rgba32float, write>;\n\n@compute @workgroup_size(64)\nfn sdfGiPublishMain(@builtin(global_invocation_id) gid: vec3u) {\n  let linear = gid.x;\n  if (linear >= params.probeCount) { return; }\n  let dx = params.dimensions.x;\n  let dy = params.dimensions.y;\n  let cell = vec3u(linear % dx, (linear / dx) % dy, linear / (dx * dy));\n  let base = linear * params.recordVec4Stride;\n  let irradianceValidity = records[base];\n  let visibility = records[base + 1u];\n  // 辐照 texel:记录 vec4[0] 原样(rgba16float 量化发生在写后,采样端语义 = F5 capture)。\n  textureStore(deepGiVolume, vec2i(cell.xy), i32(cell.z), irradianceValidity);\n  // moments lane0 = (meanDistance, variance, missRatio, valid) —— vec4[1].xyz 透传。\n  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes),\n    vec4f(visibility.xyz, 1.0));\n  // moments lane1..3 = RGB L1 SH:恒零(SH 缺失合同;F5 words[12..23] 本核绝不写)。\n  let zero = vec4f(0.0);\n  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes + 1u), zero);\n  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes + 2u), zero);\n  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes + 3u), zero);\n}\n";
