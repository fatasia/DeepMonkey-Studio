/**
 * B2 MegaLights M2 生产接线 WGSL(宿主私有模板,TS-only 消费;绑定内联,不进
 * wgsl/ 单源体系 —— 与 megaLightsRuntime.composeMegaLightsShader 的宿主模板同纪律:
 * 单源 RIS 核已在 wgsl/megaLightsRis.wgsl + checksum 门,这里只放生产通路特有的
 * 两个小核,消费方唯一(megaLightsFrameController.ts),合同由
 * megaLightsFrameController.test.ts 的字面量门锁定)。
 *
 * == 表面重建核(rebuild) ==
 * 生产通路没有现成每像素视空间表面(M1 探针是合成朗伯墙):从主帧 1x depth
 * (depth32float,TEXTURE_BINDING;与 linearDepthMsaa compute 采样先例同形)+
 * worldToView×invViewProjection 组合矩阵重建视空间位置;法线由右/下邻域深度
 * 差分叉积(深度不连续处置零 = RIS 贡献零,天然输出 mask);材质为中性起步档
 * (albedo 0.8/0.78/0.75、roughness 0.5、metallic 0,与真机探针同族)——GBuffer
 * 消费(pbrShader 域)属后续切片,登记如实 degraded。
 * 输出布局与 megaLightsAbi.MEGA_LIGHTS_SURFACES_STRIDE_VEC4(3 vec4/像素)逐字互钉,
 * 直接写 MegaLightsRuntime 的 surfaces buffer(零 CPU 上传带宽)。
 *
 * == 加性合成核(composite) ==
 * 全屏三角形 render pass 读 MegaLightsRuntime 颜色 storage(fragment 阶段
 * read-only storage,合法),经 one+one 加性混合叠加进 HDR 附件(loadOp: load)
 * —— 无需 hdr 纹理 STORAGE 采样歧义、无自持中间纹理。alpha 恒加 0,附件 alpha
 * 通道逐位不变。
 */

/** 表面重建参数 uniform(80B:mat4x4f 64B + viewport 8B + 保留 8B)。 */
export const MEGA_LIGHTS_REBUILD_PARAMS_BYTES = 80;
/** 加性合成参数 uniform(16B:viewport vec2u + 保留 vec2u)。 */
export const MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES = 16;
/** 深度不连续门(相对差;与 RIS 时域深度门同族同值口径)。 */
export const MEGA_LIGHTS_REBUILD_DEPTH_GATE = 0.1;

/** 表面重建核:depth → 视空间位置/差分法线 + 中性材质;绑定宿主模板内联。 */
export const MEGA_LIGHTS_REBUILD_WGSL = /* wgsl */ `
struct DeepMegaRebuildParams {
  worldToViewInvViewProjection: mat4x4f,
  viewport: vec2u,
  reserved: vec2u,
};
@group(0) @binding(0) var<uniform> deepMegaRebuild: DeepMegaRebuildParams;
@group(0) @binding(1) var deepMegaRebuildDepth: texture_depth_2d;
@group(0) @binding(2) var<storage, read_write> deepMegaRebuildSurfaces: array<vec4f>;

const DEEP_MEGA_REBUILD_SURFACE_STRIDE: u32 = 3u;
const DEEP_MEGA_REBUILD_DEPTH_GATE: f32 = 0.1;

// 视空间重建(深度清屏值 1 = 背景返回零点,由后续法线置零统一出零贡献)。
fn deepMegaRebuildViewPosition(px: vec2u, depthSample: f32) -> vec4f {
  let dimensions = vec2f(textureDimensions(deepMegaRebuildDepth).xy);
  let uv = (vec2f(px) + vec2f(0.5, 0.5)) / dimensions;
  // NDC 语义与 shadowRayFrame 核同式(uv.y 翻转;depth ∈[0,1] 直插 z 槽)。
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depthSample, 1.0);
  let clipped = deepMegaRebuild.worldToViewInvViewProjection * ndc;
  return clipped / vec4f(clipped.w);
}

@compute @workgroup_size(8, 8)
fn deepMegaRebuildSurfacesFrame(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= deepMegaRebuild.viewport.x || gid.y >= deepMegaRebuild.viewport.y) { return; }
  let pixel = gid.xy;
  let viewport = vec2i(deepMegaRebuild.viewport);
  let bounds = vec2u(viewport - vec2i(1, 1));
  let centerDepth = textureLoad(deepMegaRebuildDepth, pixel, 0);
  let rightPixel = min(pixel + vec2u(1u, 0u), bounds);
  let downPixel = min(pixel + vec2u(0u, 1u), bounds);
  let rightDepth = textureLoad(deepMegaRebuildDepth, rightPixel, 0);
  let downDepth = textureLoad(deepMegaRebuildDepth, downPixel, 0);
  let base = (pixel.y * deepMegaRebuild.viewport.x + pixel.x) * DEEP_MEGA_REBUILD_SURFACE_STRIDE;
  // 背景/清屏深度(≥1)或右/下邻深度不连续:表面全零(零法线 → RIS 着色核
  // nDotL=0 早退,输出 mask 与合成加零同义;蓄水池权重全零不污染邻域复用)。
  let depthSpan = max(max(centerDepth, rightDepth), downDepth) - min(min(centerDepth, rightDepth), downDepth);
  let discontinuous = depthSpan > DEEP_MEGA_REBUILD_DEPTH_GATE * max(max(centerDepth, rightDepth), downDepth);
  if (centerDepth >= 1.0 || discontinuous) {
    deepMegaRebuildSurfaces[base] = vec4f(0.0);
    deepMegaRebuildSurfaces[base + 1u] = vec4f(0.0);
    deepMegaRebuildSurfaces[base + 2u] = vec4f(0.0);
    return;
  }
  let center = deepMegaRebuildViewPosition(pixel, centerDepth);
  let right = deepMegaRebuildViewPosition(rightPixel, rightDepth);
  let down = deepMegaRebuildViewPosition(downPixel, downDepth);
  let cross = cross(right.xyz - center.xyz, down.xyz - center.xyz);
  let normalLength = length(cross);
  let view = select(vec3f(0.0, 0.0, 1.0), -center.xyz / max(length(center.xyz), 0.0001), length(center.xyz) > 0.0001);
  var normal = vec3f(0.0);
  if (normalLength > 0.00000001) {
    normal = cross / normalLength;
    if (dot(normal, view) < 0.0) { normal = -normal; }
  }
  // 中性材质起步档(见模块头;M2 如实 degraded,GBuffer 消费切片替换)。
  // 布局见 megaLightsAbi:[0]=(positionView.xyz, metallic) [1]=(normalView.xyz, roughness)
  // [2]=(baseColor.xyz, 预留)。
  deepMegaRebuildSurfaces[base] = vec4f(center.xyz, 0.0);
  deepMegaRebuildSurfaces[base + 1u] = vec4f(normal, 0.5);
  deepMegaRebuildSurfaces[base + 2u] = vec4f(0.8, 0.78, 0.75, 0.0);
}
`;

/** 加性合成核:全屏三角形 + fragment 读 RIS 颜色 storage,加性混合进 HDR 附件。 */
export const MEGA_LIGHTS_COMPOSITE_WGSL = /* wgsl */ `
struct DeepMegaCompositeParams {
  viewport: vec2u,
  reserved: vec2u,
};
@group(0) @binding(0) var<uniform> deepMegaComposite: DeepMegaCompositeParams;
@group(0) @binding(1) var<storage, read> deepMegaCompositeColor: array<vec4f>;

struct DeepMegaCompositeOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn deepMegaCompositeVertex(@builtin(vertex_index) vertexIndex: u32) -> DeepMegaCompositeOutput {
  var fullscreen = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return DeepMegaCompositeOutput(vec4f(fullscreen[vertexIndex], 0.0, 1.0));
}

@fragment
fn deepMegaCompositeFragment(@builtin(position) fragmentCoordinate: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(fragmentCoordinate.xy);
  if (pixel.x >= deepMegaComposite.viewport.x || pixel.y >= deepMegaComposite.viewport.y) { return vec4f(0.0); }
  let pixelIndex = pixel.y * deepMegaComposite.viewport.x + pixel.x;
  // alpha 恒 0:加性混合下附件 alpha 通道逐位不变(仅 RGB 叠加直接光)。
  return vec4f(deepMegaCompositeColor[pixelIndex].rgb, 0.0);
}
`;
