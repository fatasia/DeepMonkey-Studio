import { PBR_DIRECT_LIGHTING_WGSL } from "./pbrDirectLightingWgsl.js";

/**
 * P0-2 可见性 buffer 三段 WGSL：meshlet id 光栅化 → 全屏材质还原 → HDR 回写。
 *
 * 位布局合同见 visibilityBufferEncoding.ts 头注释；三段与 CPU 参考解析
 * （visibilityBufferResolveReference.ts）逐公式对拍。
 * 诚实边界（本切片 deferred，不在 shader 里假装存在）：阴影图采样、clustered 光源、
 * IBL/环境、雾、AO/SSR 输入、法线贴图与逐实例逐像素插值属性（normal/uv）。
 */

export const VISIBILITY_RASTER_WGSL = /* wgsl */ `
// 可见性光栅化：只写 id，不写材质。深度与 forward 完全同源（同数值同公式的 clip.z）。
struct FrameView { currentViewProjection: mat4x4f };
@group(0) @binding(0) var<uniform> frameView: FrameView;
struct VisibilityMeta { slot: u32, reserved0: u32, reserved1: u32, reserved2: u32 };
@group(1) @binding(0) var<uniform> meta: VisibilityMeta;

struct RasterInput {
  @location(0) position: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) carrier: u32,
};
struct RasterOutput {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) slot: u32,
  @location(1) @interpolate(flat) triangle: u32,
};
@vertex fn vertexVisibility(v: RasterInput) -> RasterOutput {
  let p = vec4f(v.position, 1.0);
  let world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  var out: RasterOutput;
  // 与 pbrShader.vertexMain 相同的表达式与求值顺序：保证与 forward 深度逐位可比。
  out.clip = frameView.currentViewProjection * vec4f(world, 1.0);
  out.slot = meta.slot;
  out.triangle = v.carrier & 0xffu;
  return out;
}
@fragment fn fragmentVisibility(v: RasterOutput) -> @location(0) vec2<u32> {
  return vec2u(v.slot, v.triangle);
}
`;

export const VISIBILITY_RESOLVE_WGSL = /* wgsl */ `
fn safeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  let normalized = value * inverseSqrt(max(lengthSquared, 0.00000001));
  return select(fallback, normalized, lengthSquared > 0.00000001);
}
${PBR_DIRECT_LIGHTING_WGSL}
struct ResolveUniforms {
  inverseViewProjection: mat4x4f,
  eye: vec4f, lightDirection: vec4f, sunColor: vec4f, targetSize: vec4f,
};
@group(0) @binding(0) var<uniform> resolve: ResolveUniforms;
@group(1) @binding(0) var visibilityMap: texture_2d<u32>;
@group(1) @binding(1) var sceneDepth: texture_depth_2d;
@group(1) @binding(2) var sceneColor: texture_2d<f32>;
struct VisibilityMaterialSlot {
  colorMetal: vec4f, material: vec4f, emissiveAlpha: vec4f, reserved: vec4f,
};
@group(2) @binding(0) var<storage, read> materials: array<VisibilityMaterialSlot>;

fn isVisibilityCovered(slot: u32, packedTriangle: u32) -> bool {
  return slot != 0xffffffffu && (packedTriangle & ~0xffu) == 0u && packedTriangle < 126u;
}
fn worldFromDepth(uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = resolve.inverseViewProjection * ndc;
  return world.xyz / world.w;
}
@vertex fn vertexFullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * 2.0 - vec2f(1.0), 0.0, 1.0);
}
// 第一切片：albedo(slot 表) + 深度重建平面法线 + 太阳直射 GGX + 自发光；
// 哨兵像素原样透传 forward 颜色（等价零回归回落）。
@fragment fn fragmentVisibilityResolve(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(fragCoord.xy);
  let forward = textureLoad(sceneColor, pixel, 0);
  let ids = textureLoad(visibilityMap, pixel, 0);
  if (!isVisibilityCovered(ids.x, ids.y)) { return forward; }
  let depth = textureLoad(sceneDepth, pixel, 0);
  let uv = (vec2f(pixel) + vec2f(0.5)) / resolve.targetSize.xy;
  let world = worldFromDepth(uv, depth);
  let view = safeNormalize(resolve.eye.xyz - world, vec3f(0.0, 0.0, 1.0));
  var normal = normalize(cross(dpdx(world), dpdy(world)));
  normal = select(normal, -normal, dot(normal, view) < 0.0);
  let entry = materials[ids.x];
  let rough = clamp(entry.material.x, 0.06, 1.0) + deepGeometryRoughness(normal);
  let light = safeNormalize(resolve.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  var color = brdf(normal, view, light, entry.colorMetal.rgb, entry.colorMetal.w, rough)
    * resolve.sunColor.rgb * resolve.sunColor.w;
  color += entry.emissiveAlpha.rgb;
  return vec4f(color, 1.0);
}
`;

export const VISIBILITY_BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var compositeColor: texture_2d<f32>;
@vertex fn vertexFullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * 2.0 - vec2f(1.0), 0.0, 1.0);
}
@fragment fn fragmentBlit(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  return textureLoad(compositeColor, vec2u(fragCoord.xy), 0);
}
`;
