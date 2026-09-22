export const SSR_WORKGROUP_SIZE = 8;

/** Builds mip 0 from the live HDR source, then a bounded 2x2 radiance hierarchy. */
export const SSR_RADIANCE_DOWNSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var radianceSource: texture_2d<f32>;
@group(0) @binding(1) var radianceTarget: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn downsampleRadiance(@builtin(global_invocation_id) id: vec3<u32>) {
  let targetSize = textureDimensions(radianceTarget);
  if (id.x >= targetSize.x || id.y >= targetSize.y) { return; }
  let sourceSize = textureDimensions(radianceSource);
  if (all(sourceSize == targetSize)) {
    textureStore(radianceTarget, vec2<i32>(id.xy), textureLoad(radianceSource, vec2<i32>(id.xy), 0));
    return;
  }
  let maximum = vec2<i32>(sourceSize - vec2<u32>(1u));
  let origin = vec2<i32>(id.xy * 2u);
  let radiance = textureLoad(radianceSource, min(origin, maximum), 0)
    + textureLoad(radianceSource, min(origin + vec2i(1, 0), maximum), 0)
    + textureLoad(radianceSource, min(origin + vec2i(0, 1), maximum), 0)
    + textureLoad(radianceSource, min(origin + vec2i(1, 1), maximum), 0);
  textureStore(radianceTarget, vec2<i32>(id.xy), radiance * 0.25);
}
`;

const COMMON = /* wgsl */ `
struct SsrParams {
  sourceSize: vec2<u32>,
  traceSize: vec2<u32>,
  // x=tanHalfFov, y=aspect, z=maxDistance, w=thickness
  projection: vec4<f32>,
  // x=steps, y=refines
  tuning: vec4<u32>,
  // x=edgeFade, y=fresnelF0
  misc: vec4<f32>,
};
fn ssrSafeNormal(value: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(vec3f(0.0, 0.0, 1.0), value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
fn ssrReconstruct(coordinate: vec2<u32>, depth: f32) -> vec3f {
  // Same reconstruction contract as ambientOcclusionWgsl.reconstructPosition.
  let uv = (vec2f(coordinate) + 0.5) / vec2f(ssrParams.sourceSize);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * depth * ssrParams.projection.x * ssrParams.projection.y,
    ndc.y * depth * ssrParams.projection.x, -depth);
}
fn ssrProject(position: vec3f) -> vec2f {
  let depth = -position.z;
  let ndc = vec2f(position.x / (depth * ssrParams.projection.x * ssrParams.projection.y),
    position.y / (depth * ssrParams.projection.x));
  return vec2f((ndc.x + 1.0) / 2.0, (1.0 - ndc.y) / 2.0);
}
fn ssrEdgeFade(uv: vec2f) -> f32 {
  let fade = max(ssrParams.misc.x, 0.0001);
  let t = clamp(min(min((1.0 - uv.x) / fade, uv.x / fade), min((1.0 - uv.y) / fade, uv.y / fade)), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn ssrClampPixel(uv: vec2f) -> vec2<u32> {
  let maximum = vec2<f32>(ssrParams.sourceSize - vec2<u32>(1u));
  return vec2<u32>(clamp(floor(uv * vec2f(ssrParams.sourceSize)), vec2<f32>(0.0), maximum));
}
`;

export const SSR_TRACE_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var sourceNormal: texture_2d<f32>;
@group(0) @binding(2) var sourceColor: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> ssrParams: SsrParams;
@group(0) @binding(4) var ssrSampler: sampler;
@group(0) @binding(5) var traceTarget: texture_storage_2d<rgba16float, write>;

fn ssrLoadNormal(coordinate: vec2<u32>) -> vec3f {
  // Only the trace pipeline binds the view-normal texture.
  return ssrSafeNormal(textureLoad(sourceNormal, vec2<i32>(coordinate), 0).xyz * 2.0 - 1.0);
}
fn ssrLoadRoughness(coordinate: vec2<u32>) -> f32 {
  return clamp(textureLoad(sourceNormal, vec2<i32>(coordinate), 0).w, 0.0, 1.0);
}
fn ssrSampleRoughRadiance(uv: vec2f, roughness: f32) -> vec3f {
  // Roughness selects a bounded cone footprint from the prefiltered radiance hierarchy.
  let lod = roughness * roughness * ssrParams.misc.z;
  return textureSampleLevel(sourceColor, ssrSampler, uv, lod).rgb;
}

@compute @workgroup_size(8, 8)
fn traceReflection(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ssrParams.traceSize.x || id.y >= ssrParams.traceSize.y) { return; }
  // 半分辨率线程取 2x2 block 内的奇数像素,与 CPU 参考/C3 邻域采样约定一致。
  let coordinate = min(id.xy * 2u + vec2<u32>(1u), ssrParams.sourceSize - vec2<u32>(1u));
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(coordinate), 0).x;
  if (!(centerDepth > 0.0)) { textureStore(traceTarget, vec2<i32>(id.xy), vec4f(0.0)); return; }
  let origin = ssrReconstruct(coordinate, centerDepth);
  let normal = ssrLoadNormal(coordinate);
  let roughness = ssrLoadRoughness(coordinate);
  let incident = normalize(origin / centerDepth);
  let reflected = reflect(incident, normal);
  if (reflected.z >= 0.0) { textureStore(traceTarget, vec2<i32>(id.xy), vec4f(0.0)); return; }
  let stepLength = ssrParams.projection.z / f32(ssrParams.tuning.x);
  var hit = false; var hitUv = vec2f(0.0);
  for (var step = 1u; step <= ssrParams.tuning.x && !hit; step++) {
    let distance = f32(step) * stepLength;
    let point = origin + reflected * distance;
    let rayDepth = -point.z;
    if (rayDepth <= 0.0) { break; }
    let uv = ssrProject(point);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }
    let pixel = ssrClampPixel(uv);
    let surfaceDepth = textureLoad(sourceDepth, vec2<i32>(pixel), 0).x;
    if (!(surfaceDepth > 0.0)) { continue; }
    if (surfaceDepth < rayDepth && rayDepth - surfaceDepth < ssrParams.projection.w) {
      var lowDistance = distance - stepLength;
      var highDistance = distance;
      for (var refine = 0u; refine < ssrParams.tuning.y; refine++) {
        let middleDistance = (lowDistance + highDistance) / 2.0;
        let middle = origin + reflected * middleDistance;
        let middleUv = ssrProject(middle);
        let refinedPixel = ssrClampPixel(middleUv);
        if (textureLoad(sourceDepth, vec2<i32>(refinedPixel), 0).x < -middle.z) { highDistance = middleDistance; }
        else { lowDistance = middleDistance; }
      }
      hitUv = ssrProject(origin + reflected * ((lowDistance + highDistance) / 2.0));
      hit = true;
    }
  }
  if (!hit) { textureStore(traceTarget, vec2<i32>(id.xy), vec4f(0.0)); return; }
  let radiance = ssrSampleRoughRadiance(hitUv, roughness);
  let cosTheta = clamp(-dot(normal, incident), 0.0, 1.0);
  let fresnel = ssrParams.misc.y + (1.0 - ssrParams.misc.y) * pow(1.0 - cosTheta, 5.0);
  let mask = fresnel * ssrEdgeFade(hitUv);
  textureStore(traceTarget, vec2<i32>(id.xy), vec4f(radiance * mask, mask));
}
`;

export const SSR_COMPOSITE_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceColor: texture_2d<f32>;
@group(0) @binding(1) var sourceTrace: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> ssrParams: SsrParams;
@group(0) @binding(3) var ssrSampler: sampler;
@group(0) @binding(4) var compositeTarget: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn compositeReflection(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ssrParams.sourceSize.x || id.y >= ssrParams.sourceSize.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(ssrParams.sourceSize);
  let color = textureSampleLevel(sourceColor, ssrSampler, uv, 0.0).rgb;
  // trace 是半分辨率 rgba16float,双线性采样即上采样;alpha 通道是 mask,rgb 已含加权。
  let reflection = textureSampleLevel(sourceTrace, ssrSampler, uv, 0.0);
  // The opaque source already contains probe/environment specular. Replace that
  // fallback under a valid SSR hit instead of adding the same energy twice.
  textureStore(compositeTarget, vec2<i32>(id.xy), vec4f(color * (1.0 - reflection.a) + reflection.rgb, 1.0));
}
`;
