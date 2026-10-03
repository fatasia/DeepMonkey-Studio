/** 实例描边 WGSL:剪影/可见性掩码光栅 + 半分辨率边缘检测 + 全分辨率加法合成。仅在存在描边实例时编译。 */
export const INSTANCE_OUTLINE_WGSL = /* wgsl */ `
struct Camera { viewProjection: mat4x4f };
struct Params { shape: vec4f, visible: vec4f, hidden: vec4f };
@group(0) @binding(7) var<uniform> camera: Camera;
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var maskTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceColor: texture_2d<f32>;
@group(0) @binding(3) var edgeTexture: texture_2d<f32>;
@group(0) @binding(4) var edgeSampler: sampler;
@group(0) @binding(5) var edgeStore: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var outputColor: texture_storage_2d<rgba16float, write>;

struct MaskInput {
  @location(0) position: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(9) material: vec4f,
};
// 实例记录 material.w 的 bit 256 = 对象级 outline;未描边实例被推到裁剪体外(整三角剔除)。
@vertex fn maskVertex(v: MaskInput) -> @builtin(position) vec4f {
  if ((u32(round(v.material.w)) & 256u) == 0u) { return vec4f(2.0, 2.0, 2.0, 1.0); }
  let p = vec4f(v.position, 1.0);
  return camera.viewProjection * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
}
// 先无深度测试写剪影(R=0,G=0),再带深度测试把可见部分 G 写回 1。
@fragment fn silhouetteFragment() -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
@fragment fn visibleFragment() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }

fn maskAt(xy: vec2i) -> vec2f {
  return textureLoad(maskTexture, clamp(xy, vec2i(0), vec2i(textureDimensions(maskTexture)) - 1), 0).rg;
}
// 半分辨率纹素 = 全分辨率 2x2 均值(同 OutlinePass 对掩码的双线性降采样)。
fn maskHalf(xy: vec2i) -> vec2f {
  let base = xy * 2;
  return (maskAt(base) + maskAt(base + vec2i(1, 0)) + maskAt(base + vec2i(0, 1)) + maskAt(base + vec2i(1, 1))) * 0.25;
}
@compute @workgroup_size(8, 8) fn edgeMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(edgeStore); if (any(id.xy >= size)) { return; }
  let p = vec2i(id.xy); let k = max(i32(round(params.shape.y)), 1);
  let c1 = maskHalf(p + vec2i(k, 0)); let c2 = maskHalf(p - vec2i(k, 0));
  let c3 = maskHalf(p + vec2i(0, k)); let c4 = maskHalf(p - vec2i(0, k));
  let d = length(vec2f((c1.x - c2.x) * 0.5, (c3.x - c4.x) * 0.5));
  let visibility = min(min(c1.y, c2.y), min(c3.y, c4.y));
  let hidden = 1.0 - visibility > 0.001;
  textureStore(edgeStore, id.xy, vec4f(select(d, 0.0, hidden), select(0.0, d, hidden), 0.0, 1.0));
}
fn edgeAt(uv: vec2f) -> vec2f { return textureSampleLevel(edgeTexture, edgeSampler, uv, 0.0).rg; }
@compute @workgroup_size(8, 8) fn composeMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outputColor); if (any(id.xy >= size)) { return; }
  let color = textureLoad(sourceColor, id.xy, 0);
  let outside = textureLoad(maskTexture, id.xy, 0).r;
  if (outside <= 0.0) { textureStore(outputColor, id.xy, color); return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  var edge = edgeAt(uv);
  if (params.shape.z > 0.0) {
    let texel = 2.0 / vec2f(size);
    let wide = (edgeAt(uv + texel * vec2f(1.0, 1.0)) + edgeAt(uv + texel * vec2f(-1.0, 1.0))
      + edgeAt(uv + texel * vec2f(1.0, -1.0)) + edgeAt(uv + texel * vec2f(-1.0, -1.0))) * 0.25;
    edge += wide * params.shape.z;
  }
  let add = params.shape.x * outside * (edge.x * params.visible.rgb + edge.y * params.hidden.rgb);
  textureStore(outputColor, id.xy, vec4f(color.rgb + add, color.a));
}
`;
