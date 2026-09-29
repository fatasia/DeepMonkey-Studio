/** C10 接触阴影步进内核:半分辨率,上一帧线性深度,朝光方向屏幕空间短距射线。 */

export const CONTACT_SHADOW_UNIFORM_FLOATS = 28;
export const CONTACT_SHADOW_UNIFORM_BYTES = CONTACT_SHADOW_UNIFORM_FLOATS * 4;

/** 步数档位在内核常量层注入(contactShadowWgsl(steps)),避免 uniform 分支。 */
const CONTACT_SHADOW_WGSL_TEMPLATE = /* wgsl */ `
struct ContactParams {
  projection: mat4x4f, // 视空间→裁剪(reconstruct 产出的就是视空间点,只差投影)。
  lightView: vec4f,     // xyz: 视空间表面指向光源单位向量; w: tanHalfFov
  tuning: vec4f,        // x: thickness(world), y: strength, z: falloff, w: radius(world)
  screen: vec4f,        // xy: 深度纹理尺寸(texel), zw: 遮蔽贴尺寸(texel)
};
@group(0) @binding(0) var<uniform> contact: ContactParams;
@group(0) @binding(1) var sourceDepth: texture_2d<f32>;
@group(0) @binding(2) var contactMask: texture_storage_2d<rgba16float, write>;

fn contactReconstruct(coordinate: vec2<u32>, depth: f32) -> vec3f {
  // 与 ambientOcclusionWgsl.reconstructPosition 同一重建合同(正线性视深)。
  let uv = (vec2f(coordinate) + 0.5) / contact.screen.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * depth * contact.lightView.w * (contact.screen.x / contact.screen.y),
    ndc.y * depth * contact.lightView.w, -depth);
}

fn contactProject(position: vec3f) -> vec2f {
  let clip = contact.projection * vec4f(position, 1.0);
  let safeW = select(-max(abs(clip.w), 0.00000001), max(abs(clip.w), 0.00000001), clip.w >= 0.0);
  return clamp(clip.xy / safeW * vec2f(0.5, -0.5) + 0.5, vec2f(0.0), vec2f(1.0));
}

fn contactOcclusion(rayDepth: f32, surfaceDepth: f32) -> f32 {
  let depthDelta = rayDepth - surfaceDepth;
  if (!(depthDelta > contact.tuning.x)) { return 0.0; }
  // 近带满遮蔽,厚度外沿 falloff 幂衰减——接触感集中在根部,远离接触根部自然消隐。
  let band = clamp(depthDelta / max(contact.tuning.x * 4.0, 0.0001), 0.0, 1.0);
  return clamp(pow(band, contact.tuning.z), 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn contactShadowMain(@builtin(global_invocation_id) id: vec3u) {
  let maskSize = textureDimensions(contactMask);
  if (id.x >= maskSize.x || id.y >= maskSize.y) { return; }
  let coordinate = min(id.xy * 2u + vec2u(1u), vec2u(contact.screen.xy) - vec2u(1u));
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(coordinate), 0).x;
  if (!(centerDepth > 0.0)) { textureStore(contactMask, vec2<i32>(id.xy), vec4f(0.0)); return; }
  let origin = contactReconstruct(coordinate, centerDepth);
  let direction = normalize(contact.lightView.xyz);
  let stepLength = contact.tuning.w / f32(CONTACT_STEPS);
  var occlusion = 0.0;
  for (var step = 1u; step <= CONTACT_STEPS; step++) {
    let point = origin + direction * (f32(step) * stepLength);
    let rayDepth = -point.z;
    if (rayDepth <= 0.0) { break; }
    let uv = contactProject(point);
    let pixel = vec2<u32>(clamp(floor(uv * contact.screen.xy), vec2<f32>(0.0), vec2<f32>(contact.screen.xy) - vec2<f32>(1.0)));
    let surfaceDepth = textureLoad(sourceDepth, vec2<i32>(pixel), 0).x;
    if (!(surfaceDepth > 0.0)) { continue; }
    occlusion = max(occlusion, contactOcclusion(rayDepth, surfaceDepth));
    if (occlusion >= 1.0) { break; }
  }

  textureStore(contactMask, vec2<i32>(id.xy), vec4f(occlusion * contact.tuning.y, 0.0, 0.0, 1.0));
}
`;

/** 注入 CONTACT_STEPS 档位步数常量。 */
export function contactShadowWgsl(steps: number): string {
  if (!Number.isSafeInteger(steps) || steps < 2 || steps > 64) {
    throw new RangeError("Contact shadow steps must be a safe integer in [2, 64].");
  }
  return CONTACT_SHADOW_WGSL_TEMPLATE.replace(/CONTACT_STEPS/gu, `${steps}u`);
}

/** C10 apply 内核:全分辨率,按遮蔽衰减合成颜色(AO 同语义)。 */
export const CONTACT_APPLY_WGSL = /* wgsl */ [
  '',
  '@group(0) @binding(0) var applyColor: texture_2d<f32>;',
  '@group(0) @binding(1) var applyMask: texture_2d<f32>;',
  '@group(0) @binding(2) var applySampler: sampler;',
  '@group(0) @binding(3) var applyTarget: texture_storage_2d<rgba16float, write>;',
  '',
  '@compute @workgroup_size(8, 8)',
  'fn contactApplyMain(@builtin(global_invocation_id) id: vec3u) {',
  '  let size = textureDimensions(applyTarget);',
  '  if (id.x >= size.x || id.y >= size.y) { return; }',
  '  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);',
  '  let color = textureSampleLevel(applyColor, applySampler, uv, 0.0).rgb;',
  '  let maskSize = textureDimensions(applyMask);',
  '  let maskTexel = vec2<i32>(clamp(vec2<u32>(uv * vec2f(maskSize)), vec2<u32>(0u), maskSize - vec2u(1u)));',
  '  let mask = textureLoad(applyMask, maskTexel, 0).x;',
  '  textureStore(applyTarget, vec2<i32>(id.xy), vec4f(color * (1.0 - mask), 1.0));',
  '}',
].join('\n');
