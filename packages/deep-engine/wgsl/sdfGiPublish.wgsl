// Brief-GI M3 探针消费物化核(2026-10-05):把 96B IrradianceProbeRecord 探针场物化为
// 主 pass 探针 clipmap 采样纹理(probeClipmapTextureSampling 的 group3 纹理 ABI),让
// pbrShader shade() 的 ambient 项 mix(environmentIrradiance, gi.rgb, gi.a) 真实消费
// SDF GI 探针记录(消费接线切片:此前 dispatch 链已达标但探针记录无主 pass 消费)。
//
// == texel 布局合同(与 F5 capture 侧逐字对齐;偏差即主 pass 采样错位)==
// - deepGiVolume(texture_2d_array rgba16float):宽=dx、高=dy、层数=dz;
//   texel(cell.xy, layer=cell.z) = (irradiance.rgb, validity) —— record vec4[0] 透传。
// - deepGiMoments(texture_2d_array rgba32float):同一宽高,层数 = dz×4 lanes;
//   lane 层 = cell.z×4 + lane;lane0 = (meanDistance, variance, missRatio, valid) =
//   record vec4[1].xyz 透传 + valid=1(moments 在场);lane1..3 = F5 words[12..23]
//   RGB L1 SH —— **恒写零**(SH 缺失合同,specular 门走标量 fallback;本核绝不合成 SH)。
// - 采样端 realMoments 判据 = moments 2D 尺寸 == level gridSize.xy 且
//   layers >= (level+1)×dz×4;本核输出恰好满足(单层 level=0)。
//
// == 确定性(与 sdfGiProbeUpdate/sdfSkyVisibilityTrace 同族)==
// 每 lane 独立读写一个探针格 cell 的 texel:无跨 lane 通信、无 workgroup 内存、无原子,
// 同输入同 dispatch 逐位回放;lane ≥ probeCount 早退。记录值透传不重算(烘焙/更新核
// 已保证有限;rgba16float 量化是写后精度,不是本核注入误差)。

struct PublishParams {
  /** 探针格分辨率(x,y,z;z 为纹理层数轴)。 */
  dimensions: vec3u,
  /** 探针总数 = dx×dy×dz(lane 越界早退线)。 */
  probeCount: u32,
  /** 96B 记录 ABI 的 vec4 步长(=6;漂移即 ABI 破坏,与打包侧互钉)。 */
  recordVec4Stride: u32,
  /** moments lane 数(F5 合同 = 4;与 probeClipmapTextureSampling 判据互钉)。 */
  momentLanes: u32,
};

@group(0) @binding(0) var<uniform> params: PublishParams;
// 探针记录存储(vec4[6]/探针,96B IrradianceProbeRecord ABI;sdfGiProbeUpdate 的输出)。
@group(0) @binding(1) var<storage, read> records: array<vec4f>;
// 主 pass deepGiSampleTexture 的辐照体积(storage 写视图;rgba16float = F5 capture 同格式)。
@group(0) @binding(2) var deepGiVolume: texture_storage_2d_array<rgba16float, write>;
// 主 pass 可见性/SH moments(lane 扩容体积;rgba32float = F5 capture 同格式)。
@group(0) @binding(3) var deepGiMoments: texture_storage_2d_array<rgba32float, write>;

@compute @workgroup_size(64)
fn sdfGiPublishMain(@builtin(global_invocation_id) gid: vec3u) {
  let linear = gid.x;
  if (linear >= params.probeCount) { return; }
  let dx = params.dimensions.x;
  let dy = params.dimensions.y;
  let cell = vec3u(linear % dx, (linear / dx) % dy, linear / (dx * dy));
  let base = linear * params.recordVec4Stride;
  let irradianceValidity = records[base];
  let visibility = records[base + 1u];
  // 辐照 texel:记录 vec4[0] 原样(rgba16float 量化发生在写后,采样端语义 = F5 capture)。
  textureStore(deepGiVolume, vec2i(cell.xy), i32(cell.z), irradianceValidity);
  // moments lane0 = (meanDistance, variance, missRatio, valid) —— vec4[1].xyz 透传。
  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes),
    vec4f(visibility.xyz, 1.0));
  // moments lane1..3 = RGB L1 SH:恒零(SH 缺失合同;F5 words[12..23] 本核绝不写)。
  let zero = vec4f(0.0);
  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes + 1u), zero);
  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes + 2u), zero);
  textureStore(deepGiMoments, vec2i(cell.xy), i32(cell.z * params.momentLanes + 3u), zero);
}
