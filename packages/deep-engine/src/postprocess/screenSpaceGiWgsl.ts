export const SSGI_WORKGROUP_SIZE = 8;

/**
 * P2 SSGI 屏空间漫射一次反弹核。约定与 SSR trace/composite 同构(线性视深度重建/
 * 视空间 unorm 法线解码/半分辨率奇数像素采样/厚度带命中/二分细化/屏边衰减),
 * 差异只在射线方向(镜面反射 → 余弦半球采样)与合成语义(替换 → 加性)。
 */

const COMMON = /* wgsl */ `
struct SsgiParams {
  sourceSize: vec2<u32>,
  traceSize: vec2<u32>,
  // x=tanHalfFov, y=aspect, z=maxDistance(bounce radius), w=thickness
  projection: vec4<f32>,
  // x=steps, y=samples, z=seed, w=refines
  tuning: vec4<u32>,
  // x=intensity, y=edgeFade
  misc: vec4<f32>,
};
fn ssgiSafeNormal(value: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(vec3f(0.0, 0.0, 1.0), value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
fn ssgiReconstruct(coordinate: vec2<u32>, depth: f32) -> vec3f {
  // Same reconstruction contract as SSR/ssrReconstruct (ambientOcclusion 同族).
  let uv = (vec2f(coordinate) + 0.5) / vec2f(ssgiParams.sourceSize);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * depth * ssgiParams.projection.x * ssgiParams.projection.y,
    ndc.y * depth * ssgiParams.projection.x, -depth);
}
fn ssgiProject(position: vec3f) -> vec2f {
  let depth = -position.z;
  let ndc = vec2f(position.x / (depth * ssgiParams.projection.x * ssgiParams.projection.y),
    position.y / (depth * ssgiParams.projection.x));
  return vec2f((ndc.x + 1.0) / 2.0, (1.0 - ndc.y) / 2.0);
}
fn ssgiEdgeFade(uv: vec2f) -> f32 {
  let fade = max(ssgiParams.misc.y, 0.0001);
  let t = clamp(min(min((1.0 - uv.x) / fade, uv.x / fade), min((1.0 - uv.y) / fade, uv.y / fade)), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn ssgiClampPixel(uv: vec2f) -> vec2<u32> {
  let maximum = vec2<f32>(ssgiParams.sourceSize - vec2<u32>(1u));
  return vec2<u32>(clamp(floor(uv * vec2f(ssgiParams.sourceSize)), vec2<f32>(0.0), maximum));
}
`;

export const SSGI_TRACE_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var sourceNormal: texture_2d<f32>;
@group(0) @binding(2) var sourceColor: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> ssgiParams: SsgiParams;
@group(0) @binding(4) var ssgiSampler: sampler;
@group(0) @binding(5) var traceTarget: texture_storage_2d<rgba16float, write>;

// 确定性整数哈希(PCG,TS 镜像逐位同构;u32 回绕语义跨端一致)。
fn ssgiHash(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn ssgiRandom(seed: u32, salt: u32) -> f32 {
  return f32(ssgiHash(seed ^ ssgiHash(salt))) * 2.3283064365386963e-10;
}
// 无分支 ONB(Frisvad/Duff 变体;TS 镜像同式)。
fn ssgiOnb(normal: vec3f) -> mat3x3f {
  let sign = select(1.0, -1.0, normal.z < 0.0);
  let a = -1.0 / (sign + normal.z);
  let b = normal.x * normal.y * a;
  let tangent = vec3f(1.0 + sign * normal.x * normal.x * a, sign * b, -sign * normal.x);
  let bitangent = vec3f(b, sign + normal.y * normal.y * a, -normal.y);
  return mat3x3f(tangent, bitangent, normal);
}
// 余弦半球采样(局部空间,pdf = cos/π;估计量均值化,π 因子并入 intensity 约定)。
fn ssgiCosineHemisphere(u1: f32, u2: f32) -> vec3f {
  let radius = sqrt(u1);
  let phi = 6.283185307179586 * u2;
  return vec3f(radius * cos(phi), radius * sin(phi), sqrt(max(0.0, 1.0 - u1)));
}
fn ssgiLoadNormal(coordinate: vec2<u32>) -> vec3f {
  return ssgiSafeNormal(textureLoad(sourceNormal, vec2<i32>(coordinate), 0).xyz * 2.0 - 1.0);
}

@compute @workgroup_size(8, 8)
fn traceScreenSpaceGi(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ssgiParams.traceSize.x || id.y >= ssgiParams.traceSize.y) { return; }
  // 半分辨率线程取 2x2 block 内的奇数像素(SSR/CPU 镜像同约定)。
  let coordinate = min(id.xy * 2u + vec2<u32>(1u), ssgiParams.sourceSize - vec2<u32>(1u));
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(coordinate), 0).x;
  if (!(centerDepth > 0.0)) { textureStore(traceTarget, vec2<i32>(id.xy), vec4f(0.0)); return; }
  let origin = ssgiReconstruct(coordinate, centerDepth);
  let normal = ssgiLoadNormal(coordinate);
  let basis = ssgiOnb(normal);
  let perPixelSeed = ssgiParams.tuning.z ^ ssgiHash(coordinate.x ^ (coordinate.y << 16u));
  var accumulated = vec3f(0.0);
  var hits = 0.0;
  for (var bounce = 0u; bounce < ssgiParams.tuning.y; bounce++) {
    let direction = basis * ssgiCosineHemisphere(
      ssgiRandom(perPixelSeed, bounce * 2u + 1u), ssgiRandom(perPixelSeed, bounce * 2u + 2u));
    // 不丢弃朝向相机的半球:漫射积分一半能量在 normal·(-view) 侧,屏空间对更近几何
    // 可解析(rayDepth 递减,厚度带自然拒绝同面自命中);与 SSR 的镜向守卫不同源。
    let stepLength = ssgiParams.projection.z / f32(ssgiParams.tuning.x);
    var hit = false; var hitUv = vec2f(0.0); var hitDistance = 0.0;
    for (var step = 1u; step <= ssgiParams.tuning.x && !hit; step++) {
      let distance = f32(step) * stepLength;
      let point = origin + direction * distance;
      let rayDepth = -point.z;
      if (rayDepth <= 0.0) { break; }
      let uv = ssgiProject(point);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { break; }
      let pixel = ssgiClampPixel(uv);
      let surfaceDepth = textureLoad(sourceDepth, vec2<i32>(pixel), 0).x;
      if (!(surfaceDepth > 0.0)) { continue; }
      if (surfaceDepth < rayDepth && rayDepth - surfaceDepth < ssgiParams.projection.w) {
        var lowDistance = distance - stepLength;
        var highDistance = distance;
        for (var refine = 0u; refine < ssgiParams.tuning.w; refine++) {
          let middleDistance = (lowDistance + highDistance) / 2.0;
          let middle = origin + direction * middleDistance;
          let middleUv = ssgiProject(middle);
          let refinedPixel = ssgiClampPixel(middleUv);
          let refinedDepth = textureLoad(sourceDepth, vec2<i32>(refinedPixel), 0).x;
          if (refinedDepth > 0.0 && refinedDepth < -middle.z) { highDistance = middleDistance; }
          else { lowDistance = middleDistance; }
        }
        hitDistance = (lowDistance + highDistance) / 2.0;
        hitUv = ssgiProject(origin + direction * hitDistance);
        let finalPixel = ssgiClampPixel(hitUv);
        if (!(textureLoad(sourceDepth, vec2<i32>(finalPixel), 0).x > 0.0)) { continue; }
        hit = true;
      }
    }
    if (!hit) { continue; }
    let radiance = textureSampleLevel(sourceColor, ssgiSampler, hitUv, 0.0).rgb;
    let fadeT = clamp(hitDistance / ssgiParams.projection.z, 0.0, 1.0);
    let falloff = (1.0 - fadeT) * (1.0 - fadeT) * ssgiEdgeFade(hitUv);
    accumulated += radiance * falloff;
    hits += 1.0;
  }
  let sampleCount = max(f32(ssgiParams.tuning.y), 1.0);
  let gi = accumulated / sampleCount * ssgiParams.misc.x;
  textureStore(traceTarget, vec2<i32>(id.xy), vec4f(gi, hits / sampleCount));
}
`;

export const SSGI_COMPOSITE_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceColor: texture_2d<f32>;
@group(0) @binding(1) var sourceTrace: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> ssgiParams: SsgiParams;
@group(0) @binding(3) var ssgiSampler: sampler;
@group(0) @binding(4) var compositeTarget: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn compositeScreenSpaceGi(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ssgiParams.sourceSize.x || id.y >= ssgiParams.sourceSize.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(ssgiParams.sourceSize);
  let color = textureSampleLevel(sourceColor, ssgiSampler, uv, 0.0).rgb;
  // trace 是半分辨率 rgba16float,双线性采样即上采样;GI 低频信号,加性合成
  // (替换语义不适用:反弹能量不来自被替换项,探针/IBL ambient 在 shader 内已定)。
  let gi = textureSampleLevel(sourceTrace, ssgiSampler, uv, 0.0);
  textureStore(compositeTarget, vec2<i32>(id.xy), vec4f(color + gi.rgb, 1.0));
}
`;
