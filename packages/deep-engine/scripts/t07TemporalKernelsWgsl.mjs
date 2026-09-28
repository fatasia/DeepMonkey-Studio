/**
 * T07 harness WGSL:-motion 内核按 pbrShader.geometryOutput 的 MV 公式在像素中心
 * 生成运动场(当前→上一 UV,含抖动差与 ±2 钳制);上采样为 4 tap 手工双线性。
 * 注意:存储格式用 rgba16float——基础 WebGPU 不允许 rg16float 作 storage 格式
 * (生产中 motion 是渲染目标格式 rg16float,数值语义一致)。
 */
export const MOTION_WGSL = /* wgsl */ `
struct MotionParams { sizeObjects: vec4<u32>, };
@group(0) @binding(0) var worldTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> relativeRows: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> motionData: array<vec4<f32>>;
@group(0) @binding(3) var outputMotion: texture_storage_2d<rgba16float, write>;

fn clipUv(clip: vec4f) -> vec2f { return clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5, 0.5); }
fn transform(base: u32, p: vec3f) -> vec4f {
  return motionData[base] * p.x + motionData[base + 1u] * p.y + motionData[base + 2u] * p.z + motionData[base + 3u];
}

@compute @workgroup_size(8, 8)
fn computeMotion(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = vec2<u32>(motionData[9].xy);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let sampleValue = textureLoad(worldTexture, vec2<i32>(id.xy), 0);
  let objectId = u32(sampleValue.w + 0.5);
  let objectCount = u32(motionData[9].z + 0.5);
  var row0 = vec4f(1.0, 0.0, 0.0, 0.0); var row1 = vec4f(0.0, 1.0, 0.0, 0.0); var row2 = vec4f(0.0, 0.0, 1.0, 0.0);
  if (objectId >= 1u && objectId <= objectCount) {
    let base = (objectId - 1u) * 3u;
    row0 = relativeRows[base]; row1 = relativeRows[base + 1u]; row2 = relativeRows[base + 2u];
  }
  let worldPoint = vec4f(sampleValue.xyz, 1.0);
  let previousWorld = vec3f(dot(row0, worldPoint), dot(row1, worldPoint), dot(row2, worldPoint));
  let currentClip = transform(0u, sampleValue.xyz);
  let previousClip = transform(4u, previousWorld);
  let jitterDelta = motionData[8].xy;
  let motion = clamp(clipUv(previousClip) - clipUv(currentClip) - jitterDelta, vec2f(-2.0), vec2f(2.0));
  textureStore(outputMotion, vec2<i32>(id.xy), vec4f(motion, 0.0, 1.0));
}
`;

export const UPSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> upParams: array<vec4<f32>>;

// 内部分辨率上采样:目标像素中心映射回内部纹理做 4 tap 手工双线性(不引入 sampler 绑定)。
@compute @workgroup_size(8, 8)
fn upsampleBilinear(@builtin(global_invocation_id) id: vec3<u32>) {
  let sourceSize = vec2f(upParams[0].xy);
  let outputSize = vec2f(upParams[0].zw);
  if (id.x >= u32(outputSize.x) || id.y >= u32(outputSize.y)) { return; }
  let uv = (vec2f(id.xy) + vec2f(0.5)) / outputSize;
  let position = uv * sourceSize - vec2f(0.5);
  let base = vec2i(floor(position));
  let fraction = fract(position);
  var color = vec4f(0.0);
  for (var oy = 0; oy < 2; oy++) { for (var ox = 0; ox < 2; ox++) {
    let weight = select(1.0 - fraction.x, fraction.x, ox == 1) * select(1.0 - fraction.y, fraction.y, oy == 1);
    let coordinate = clamp(base + vec2i(ox, oy), vec2i(0), vec2i(sourceSize) - vec2i(1));
    color = color + textureLoad(sourceTexture, coordinate, 0) * weight;
  } }
  textureStore(outputTexture, vec2<i32>(id.xy), color);
}
`;
