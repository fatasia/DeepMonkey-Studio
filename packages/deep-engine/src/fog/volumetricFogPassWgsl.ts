// G7 体积雾半分辨率 ray-march compute kernel(切片一)。
// 数学逐式对拍基线:./volumetricFog.ts 的 CPU 参考(henyeyGreensteinPhase / densityAtHeight /
// rayHeightAt 与 Beer-Lambert 积分)。下方公式表达式与 CPU 侧逐一对应,由
// volumetricFogPassCpu.test.ts 的字符串级断言锁死,任何一侧单独改动都会测试失败。
// 精度口径:GPU 为 f32,CPU 基线为 f64;表达式与求值顺序一致,低位差异是既接受的漂移
// (与 SSR/AO 族同纪律),公式级对等由测试保证。

export const VOLUMETRIC_FOG_WORKGROUP_SIZE = 8;

export const VOLUMETRIC_FOG_MARCH_WGSL = /* wgsl */ `
struct FogParams {
  sourceSize: vec2<u32>,
  scatterSize: vec2<u32>,
  // x=tanHalfFov, y=aspect
  projection: vec4<f32>,
  // x=baseExtinction, y=scaleHeight, z=anisotropy, w=albedo —— 与 CPU VolumetricMedium 同序
  medium: vec4<f32>,
  // xyz=视图空间光方向(核内归一化,与 VolumetricLight.direction 同约定), w=maxDistance
  lightDirection: vec4<f32>,
  // xyz=线性 HDR 光辐射亮度
  lightRadiance: vec4<f32>,
  // x=steps
  tuning: vec4<u32>,
};
const FOG_EPSILON: f32 = 0.00000001;
const FOG_TRANSMITTANCE_FLOOR: f32 = 0.0001;
const FOG_PI: f32 = 3.141592653589793;
fn henyeyGreensteinPhase(cosTheta: f32, anisotropy: f32) -> f32 {
  let g2 = anisotropy * anisotropy;
  let denominator = 4.0 * FOG_PI * sqrt(pow(max(1.0 - 2.0 * anisotropy * cosTheta + g2, FOG_EPSILON), 3.0));
  return (1.0 - g2) / denominator;
}
fn densityAtHeight(height: f32, baseExtinction: f32, scaleHeight: f32) -> f32 {
  return baseExtinction * exp(-max(height, 0.0) / scaleHeight);
}
fn ndcAt(coordinate: vec2<u32>) -> vec2f {
  let uv = (vec2f(coordinate) + 0.5) / vec2f(fogParams.sourceSize);
  return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}
// 与 ambientOcclusionWgsl.reconstructPosition / screenSpaceReflectionWgsl.ssrReconstruct
// 同一视图空间重建契约。
fn reconstructPosition(coordinate: vec2<u32>, depth: f32) -> vec3f {
  let ndc = ndcAt(coordinate);
  return vec3f(ndc.x * depth * fogParams.projection.x * fogParams.projection.y,
    ndc.y * depth * fogParams.projection.x, -depth);
}
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> fogParams: FogParams;
@group(0) @binding(2) var scatterTarget: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn marchVolumetricFog(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= fogParams.scatterSize.x || id.y >= fogParams.scatterSize.y) { return; }
  // 半分辨率线程取 2x2 block 内的奇数像素,与 AO/SSR 的 CPU 镜像采样约定一致。
  let coordinate = min(id.xy * 2u + vec2<u32>(1u), fogParams.sourceSize - vec2<u32>(1u));
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(coordinate), 0).x;
  let tanHalfFov = fogParams.projection.x;
  let aspect = fogParams.projection.y;
  let baseExtinction = fogParams.medium.x;
  let scaleHeight = fogParams.medium.y;
  let anisotropy = fogParams.medium.z;
  let albedo = fogParams.medium.w;
  let ndc = ndcAt(coordinate);
  // 相机位于视图空间原点:单位深度射线端点,几何与天空像素共用同一方向。
  let rayUnit = vec3f(ndc.x * tanHalfFov * aspect, ndc.y * tanHalfFov, -1.0);
  let rayDirection = normalize(rayUnit);
  // 几何像素步进到深度重建的世界位置;天空像素步进到 maxDistance。
  let marchDistance = select(fogParams.lightDirection.w,
    length(reconstructPosition(coordinate, centerDepth)), centerDepth > 0.0);
  if (!(marchDistance > 0.0)) { textureStore(scatterTarget, vec2<i32>(id.xy), vec4f(0.0, 0.0, 0.0, 1.0)); return; }
  let lightDirection = normalize(fogParams.lightDirection.xyz);
  let cosTheta = dot(rayDirection, lightDirection);
  let phase = henyeyGreensteinPhase(cosTheta, anisotropy);
  let stepLength = marchDistance / f32(fogParams.tuning.x);
  var inscatter = vec3f(0.0, 0.0, 0.0);
  var transmittance = 1.0;
  // 中点采样 + Beer-Lambert 积分,公式与求值顺序同 CPU 参考 rayMarchVolumetricFog:
  // height = rayHeightAt(0, rayDirection.y, t) 的核内实例(相机在视图空间原点)。
  // 切片一无阴影钩子:shadow ≡ 1(×1.0 不改变乘积),阴影步进是后续切片。
  for (var step = 0u; step < fogParams.tuning.x; step++) {
    let distance = (f32(step) + 0.5) * stepLength;
    let height = rayDirection.y * distance;
    let opticalDepth = densityAtHeight(height, baseExtinction, scaleHeight) * stepLength;
    if (opticalDepth < FOG_EPSILON) { continue; }
    let extinction = exp(-opticalDepth);
    let scattering = albedo * opticalDepth * phase * 1.0;
    inscatter += fogParams.lightRadiance.xyz * (scattering * transmittance);
    transmittance *= extinction;
    if (transmittance < FOG_TRANSMITTANCE_FLOOR) { break; }
  }
  textureStore(scatterTarget, vec2<i32>(id.xy), vec4f(inscatter, transmittance));
}
`;
