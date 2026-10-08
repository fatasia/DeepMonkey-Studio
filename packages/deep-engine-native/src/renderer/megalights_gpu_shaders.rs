use super::*;

/// 表面重建核(native 变体:MSAA 深度逐样本 min;其余与 TS
/// `MEGA_LIGHTS_REBUILD_WGSL` 逐式同构——NDC uv.y 翻转、右/下差分法线、
/// 深度门 0.1、中性材质、布局 [pos,metallic]/[normal,roughness]/[baseColor,-])。
pub(super) const REBUILD_WGSL: &str = r#"
struct DeepMegaRebuildParams {
  worldToViewInvViewProjection: mat4x4f,
  viewport: vec2u,
  reserved: vec2u,
};
@group(0) @binding(0) var<uniform> deepMegaRebuild: DeepMegaRebuildParams;
@group(0) @binding(1) var deepMegaRebuildDepth: texture_depth_multisampled_2d;
@group(0) @binding(2) var<storage, read_write> deepMegaRebuildSurfaces: array<vec4f>;

const DEEP_MEGA_REBUILD_SURFACE_STRIDE: u32 = 3u;
const DEEP_MEGA_REBUILD_DEPTH_GATE: f32 = 0.1;
const DEEP_MEGA_DEPTH_SAMPLES: u32 = 4u;

// MSAA 深度逐样本 min(native 前向深度 4x;等值样本路径 min 恒等)。
fn deepMegaRebuildSampleDepth(px: vec2u) -> f32 {
  var depth = textureLoad(deepMegaRebuildDepth, px, 0u);
  var sample = 1u;
  loop {
    if (sample >= DEEP_MEGA_DEPTH_SAMPLES) { break; }
    depth = min(depth, textureLoad(deepMegaRebuildDepth, px, sample));
    sample = sample + 1u;
  }
  return depth;
}

// 视空间重建(深度清屏值 1 = 背景返回零点,由后续法线置零统一出零贡献)。
fn deepMegaRebuildViewPosition(px: vec2u, depthSample: f32) -> vec4f {
  let dimensions = vec2f(textureDimensions(deepMegaRebuildDepth));
  let uv = (vec2f(px) + vec2f(0.5, 0.5)) / dimensions;
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
  let centerDepth = deepMegaRebuildSampleDepth(pixel);
  let rightPixel = min(pixel + vec2u(1u, 0u), bounds);
  let downPixel = min(pixel + vec2u(0u, 1u), bounds);
  let rightDepth = deepMegaRebuildSampleDepth(rightPixel);
  let downDepth = deepMegaRebuildSampleDepth(downPixel);
  let base = (pixel.y * deepMegaRebuild.viewport.x + pixel.x) * DEEP_MEGA_REBUILD_SURFACE_STRIDE;
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
  let crossed = cross(right.xyz - center.xyz, down.xyz - center.xyz);
  let normalLength = length(crossed);
  let view = select(vec3f(0.0, 0.0, 1.0), -center.xyz / max(length(center.xyz), 0.0001), length(center.xyz) > 0.0001);
  var normal = vec3f(0.0);
  if (normalLength > 0.00000001) {
    normal = crossed / normalLength;
    if (dot(normal, view) < 0.0) { normal = -normal; }
  }
  deepMegaRebuildSurfaces[base] = vec4f(center.xyz, 0.0);
  deepMegaRebuildSurfaces[base + 1u] = vec4f(normal, 0.5);
  deepMegaRebuildSurfaces[base + 2u] = vec4f(0.8, 0.78, 0.75, 0.0);
}
"#;

/// 加性合成核(TS `MEGA_LIGHTS_COMPOSITE_WGSL` 同款:全屏三角形 + fragment 读
/// RIS 颜色 storage,alpha 恒 0)。
pub(super) const COMPOSITE_WGSL: &str = r#"
struct DeepMegaCompositeParams {
  viewport: vec2u,
  exposure: f32,
  reserved: u32,
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
  return vec4f(deepMegaCompositeColor[pixelIndex].rgb * deepMegaComposite.exposure, 0.0);
}
"#;

/// RIS 生产 shader 组合(TS `composeMegaLightsShader` legacy 档 native 同构:
/// 绑定 0-8 + 可见性恒 1 注入 + IES 单源 + RIS 核 + build/shade 入口)。
pub(crate) fn compose_production_shader() -> String {
    format!(
        r#"
@group(0) @binding(0) var<uniform> deepMegaFrame: DeepMegaParams;
@group(0) @binding(1) var<storage, read> deepMegaLights: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> deepMegaSurfaces: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> deepMegaMotion: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> deepMegaReservoirsA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> deepMegaReservoirsB: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> deepMegaColor: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> deepMegaColorHistory: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> deepIesShading: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read> deepMegaVisibility: array<f32>;

// Production mask comes from winner TLAS queries; the legacy oracle disables it.
fn deepMegaVisibilityAt(pixelIndex: u32) -> f32 {{
  if (deepMegaFrame.visibilityEnabled == 0u) {{ return 1.0; }}
  return deepMegaVisibility[pixelIndex];
}}

{DEEP_IES_SAMPLING_WGSL}

{DEEP_MEGA_LIGHTS_RIS_WGSL}

const DEEP_MEGA_SURFACES_STRIDE: u32 = {SURFACE_STRIDE}u;

@compute @workgroup_size(8, 8)
fn megaBuildMain(@builtin(global_invocation_id) gid: vec3u) {{
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) {{ return; }}
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE];
  let surfaceB = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 2u];
  let built = deepMegaBuildReservoir(deepMegaFrame, pixelIndex,
    surfaceA, surfaceB, surfaceC, deepMegaReservoirsB[pixelIndex], deepMegaMotion[pixelIndex].xy);
  deepMegaReservoirsA[pixelIndex] = built;
}}

@compute @workgroup_size(8, 8)
fn megaShadeMain(@builtin(global_invocation_id) gid: vec3u) {{
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) {{ return; }}
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE];
  let surfaceB = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 2u];
  var center = deepMegaReservoirUnpack(deepMegaReservoirsA[pixelIndex]);
  let color = deepMegaReuseAndShade(deepMegaFrame, pixelIndex, surfaceA, surfaceB, surfaceC, &center);
  var blended = color;
  if (deepMegaFrame.temporalEnabled != 0u) {{
    blended = mix(deepMegaColorHistory[pixelIndex].rgb, color, vec3f(deepMegaFrame.alphaBlend));
  }}
  deepMegaColor[pixelIndex] = vec4f(blended, 0.0);
  deepMegaColorHistory[pixelIndex] = vec4f(blended, 0.0);
  deepMegaReservoirsB[pixelIndex] = deepMegaReservoirPack(center, -surfaceA.z);
}}
"#
    )
}

