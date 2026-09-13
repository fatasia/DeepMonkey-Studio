/** 默认摄影棚环境由 GPU 生成；GGX 预过滤、余弦积分与 DFG 仅初始化时执行。 */
export const environmentShader = /* wgsl */ `
struct Settings { roughness: f32, size: f32, diffuse: u32, samples: u32 };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var outputCube: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var outputBrdf: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var inputEnvironment: texture_2d<f32>;
@group(0) @binding(4) var inputSampler: sampler;
const PI: f32 = 3.14159265;
fn hammersley(i: u32, count: u32) -> vec2f {
  return vec2f(f32(i) / f32(count), f32(reverseBits(i)) * 2.3283064365386963e-10);
}
fn basis(n: vec3f, direction: vec3f) -> vec3f {
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.99);
  let tangent = normalize(cross(up, n));
  return normalize(tangent * direction.x + cross(n, tangent) * direction.y + n * direction.z);
}
fn ggx(xi: vec2f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let cosine = sqrt((1.0 - xi.y) / max(1.0 + (a * a - 1.0) * xi.y, 0.00001));
  let sine = sqrt(max(1.0 - cosine * cosine, 0.0));
  return vec3f(cos(2.0 * PI * xi.x) * sine, sin(2.0 * PI * xi.x) * sine, cosine);
}
fn cubeDirection(uv: vec2f, face: u32) -> vec3f {
  switch face {
    case 0u: { return normalize(vec3f(1.0, -uv.y, -uv.x)); }
    case 1u: { return normalize(vec3f(-1.0, -uv.y, uv.x)); }
    case 2u: { return normalize(vec3f(uv.x, 1.0, uv.y)); }
    case 3u: { return normalize(vec3f(uv.x, -1.0, -uv.y)); }
    case 4u: { return normalize(vec3f(uv.x, -uv.y, 1.0)); }
    default: { return normalize(vec3f(-uv.x, -uv.y, -1.0)); }
  }
}
fn softbox(direction: vec3f, center: vec3f, width: f32, height: f32) -> f32 {
  let normal = normalize(center);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), normal));
  let up = cross(normal, right);
  let forward = dot(direction, normal);
  let point = vec2f(dot(direction, right), dot(direction, up)) / max(forward, 0.001);
  let edge = abs(point) / vec2f(width, height);
  return (1.0 - smoothstep(0.88, 1.0, max(edge.x, edge.y))) * step(0.0, forward);
}
fn studio(direction: vec3f) -> vec3f {
  let sky = mix(vec3f(0.025, 0.03, 0.04), vec3f(0.20, 0.24, 0.30), smoothstep(-0.3, 0.9, direction.y));
  let key = softbox(direction, vec3f(-1.0, 1.5, 1.0), 0.7, 0.35);
  let rim = softbox(direction, vec3f(1.0, 0.65, -1.0), 0.20, 0.8);
  let fill = softbox(direction, vec3f(0.3, 1.8, -0.5), 0.8, 0.3);
  return sky + vec3f(5.0, 4.8, 4.4) * key + vec3f(2.8, 3.4, 4.2) * rim + vec3f(1.3, 1.5, 1.8) * fill;
}
fn equirectangular(direction: vec3f) -> vec3f {
  let uv = vec2f(atan2(direction.z, direction.x) / (2.0 * PI) + 0.5,
    acos(clamp(direction.y, -1.0, 1.0)) / PI);
  return textureSampleLevel(inputEnvironment, inputSampler, uv, 0.0).rgb;
}
@compute @workgroup_size(8, 8, 1) fn environmentMain(@builtin(global_invocation_id) id: vec3u) {
  let dimensions = textureDimensions(outputCube);
  if (id.x >= dimensions.x || id.y >= dimensions.y || id.z >= 6u) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dimensions) * 2.0 - 1.0;
  let n = cubeDirection(uv, id.z);
  var color = vec3f(0.0); var weight = 0.0;
  if (settings.diffuse == 0u && settings.roughness < 0.001) { color = studio(n); weight = 1.0; }
  else {
    for (var i = 0u; i < settings.samples; i++) {
      let xi = hammersley(i, settings.samples);
      var l: vec3f;
      if (settings.diffuse == 1u) {
        let radius = sqrt(xi.y);
        l = basis(n, vec3f(cos(2.0 * PI * xi.x) * radius, sin(2.0 * PI * xi.x) * radius, sqrt(1.0 - xi.y)));
      } else { l = reflect(-n, basis(n, ggx(xi, settings.roughness))); }
      let cosine = max(dot(n, l), 0.0);
      let sampleWeight = select(cosine, 1.0, settings.diffuse == 1u);
      color += studio(l) * sampleWeight; weight += sampleWeight;
    }
  }
  // 余弦分布采样直接输出 irradiance / PI，着色时不再额外除 PI。
  textureStore(outputCube, vec2i(id.xy), i32(id.z), vec4f(color / max(weight, 0.0001), 1.0));
}
@compute @workgroup_size(8, 8, 1) fn environmentImageMain(@builtin(global_invocation_id) id: vec3u) {
  let dimensions = textureDimensions(outputCube);
  if (id.x >= dimensions.x || id.y >= dimensions.y || id.z >= 6u) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dimensions) * 2.0 - 1.0;
  let n = cubeDirection(uv, id.z);
  var color = vec3f(0.0); var weight = 0.0;
  if (settings.diffuse == 0u && settings.roughness < 0.001) {
    color = equirectangular(n); weight = 1.0;
  } else {
    for (var i = 0u; i < settings.samples; i++) {
      let xi = hammersley(i, settings.samples);
      var l: vec3f;
      if (settings.diffuse == 1u) {
        let radius = sqrt(xi.y);
        l = basis(n, vec3f(cos(2.0 * PI * xi.x) * radius, sin(2.0 * PI * xi.x) * radius, sqrt(1.0 - xi.y)));
      } else { l = reflect(-n, basis(n, ggx(xi, settings.roughness))); }
      let cosine = max(dot(n, l), 0.0);
      let sampleWeight = select(cosine, 1.0, settings.diffuse == 1u);
      color += equirectangular(l) * sampleWeight; weight += sampleWeight;
    }
  }
  textureStore(outputCube, vec2i(id.xy), i32(id.z), vec4f(color / max(weight, 0.0001), 1.0));
}
@compute @workgroup_size(8, 8, 1) fn brdfMain(@builtin(global_invocation_id) id: vec3u) {
  let dimensions = textureDimensions(outputBrdf);
  if (id.x >= dimensions.x || id.y >= dimensions.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dimensions);
  let nv = max(uv.x, 0.001); let rough = uv.y;
  let v = vec3f(sqrt(1.0 - nv * nv), 0.0, nv);
  var result = vec2f(0.0);
  for (var i = 0u; i < 256u; i++) {
    let h = ggx(hammersley(i, 256u), rough);
    let l = reflect(-v, h); let nl = max(l.z, 0.0); let nh = max(h.z, 0.0); let vh = max(dot(v, h), 0.0);
    if (nl > 0.0) {
      let k = rough * rough / 2.0;
      let g = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
      let visibility = g * vh / max(nh * nv, 0.0001); let fc = pow(1.0 - vh, 5.0);
      result += vec2f((1.0 - fc) * visibility, fc * visibility);
    }
  }
  textureStore(outputBrdf, vec2i(id.xy), vec4f(result / 256.0, 0.0, 1.0));
}
`;
