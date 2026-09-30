// I 级 C18 体积光 god rays 半分辨率 ray-march compute kernel(首刀)。
// 数学逐式对拍基线:src/lighting/volumetricGodRaysCpu.ts 的 CPU 镜像(与
// fog/volumetricFogPassCpu.ts 同纪律),公式、分支与求值顺序逐式一致;
// 字符串级同构锁在 volumetricGodRaysCpu.test.ts,字节门禁在
// volumetricGodRaysWgslChecksum.test.ts(?raw 读本文件 + SHA-256 夹具对拍)。
//
// 与 G7 体积雾核(fog/volumetricFogPassWgsl.ts)的关系:同一视图空间步进口径、
// 同一 medium 四元组(baseExtinction/scaleHeight/anisotropy/albedo 同序同语义)、
// 同一 light 约定、同一半分辨率采样坐标(id.xy*2+1)与 workgroup 尺寸(8,8);
// 唯一增量是每步中点的阴影图遮挡采样(雾核切片一 shadow ≡ 1,C18 即其后继切片),
// 以及 lightRadiance.w 携带的 strength 强度乘子(预算硬顶 [0,8])。不另起第二体积系统。
//
// 阴影图口径(首刀单级正交):光空间基由 CPU 侧 buildGodRaysShadowBasis 构造后
// 整包上传(right/up/forward 均为视图空间向量,视图空间步进点直接投影);
// 深度图 texel 存沿 forward 的深度,未命中 texel 由 CPU 侧写入 FAR 哨兵 1e9。
// 采样为最近邻 textureLoad(floor(uv*size) 后 clamp),与 CPU 镜像逐式同构、
// 无过滤歧义;域外 uv fail-open 为 lit(与 CSM 覆盖域外不受阴影的惯例一致)。
// 精度口径:GPU f32,CPU 基线 f64;表达式与求值顺序一致,低位漂移是既接受的漂移。
struct GodRaysParams {
  sourceSize: vec2<u32>,
  scatterSize: vec2<u32>,
  // x=tanHalfFov, y=aspect —— 与雾核 FogParams.projection 同序
  projection: vec4<f32>,
  // x=baseExtinction, y=scaleHeight, z=anisotropy, w=albedo —— 与雾核 FogParams.medium 同序
  medium: vec4<f32>,
  // xyz=视图空间光传播方向(核内归一化,与雾核 lightDirection 同约定), w=maxDistance
  lightDirection: vec4<f32>,
  // xyz=线性 HDR 光辐射亮度, w=strength 强度乘子
  lightRadiance: vec4<f32>,
  // xyz=光空间 right 基(视图空间), w=shadowRange 正交覆盖半宽
  shadowBasisRight: vec4<f32>,
  // xyz=光空间 up 基(视图空间), w 保留 0
  shadowBasisUp: vec4<f32>,
  // xyz=光空间 forward 基(视图空间,=核内归一化后的光方向), w=shadowBias 深度比较偏移
  shadowBasisForward: vec4<f32>,
  // x=steps, y=shadowMapSize
  tuning: vec4<u32>,
};
const GOD_RAYS_EPSILON: f32 = 0.00000001;
const GOD_RAYS_TRANSMITTANCE_FLOOR: f32 = 0.0001;
const GOD_RAYS_PI: f32 = 3.141592653589793;
fn henyeyGreensteinPhase(cosTheta: f32, anisotropy: f32) -> f32 {
  let g2 = anisotropy * anisotropy;
  let denominator = 4.0 * GOD_RAYS_PI * sqrt(pow(max(1.0 - 2.0 * anisotropy * cosTheta + g2, GOD_RAYS_EPSILON), 3.0));
  return (1.0 - g2) / denominator;
}
fn densityAtHeight(height: f32, baseExtinction: f32, scaleHeight: f32) -> f32 {
  return baseExtinction * exp(-max(height, 0.0) / scaleHeight);
}
fn ndcAt(coordinate: vec2<u32>) -> vec2f {
  let uv = (vec2f(coordinate) + 0.5) / vec2f(godRaysParams.sourceSize);
  return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}
// 与 fog/volumetricFogPassWgsl.reconstructPosition(ambientOcclusionWgsl/SSR 同族)同一视图空间重建契约。
fn reconstructPosition(coordinate: vec2<u32>, depth: f32) -> vec3f {
  let ndc = ndcAt(coordinate);
  return vec3f(ndc.x * depth * godRaysParams.projection.x * godRaysParams.projection.y,
    ndc.y * depth * godRaysParams.projection.x, -depth);
}
// 单级正交阴影图最近邻查询:光空间投影 -> texel 中心最近邻 -> 深度比较。
// 域外 fail-open 为 lit(1.0);bias = shadowBasisForward.w,防表面 acne。
// 与 CPU 镜像 marchVolumetricGodRaysPassCpu 内 shadowVisibility 逐式同构(字符串级锁)。
fn shadowVisibility(worldPos: vec3f) -> f32 {
  let basisU = dot(godRaysParams.shadowBasisRight.xyz, worldPos);
  let basisV = dot(godRaysParams.shadowBasisUp.xyz, worldPos);
  let basisW = dot(godRaysParams.shadowBasisForward.xyz, worldPos);
  let uv = vec2f(basisU, basisV) / godRaysParams.shadowBasisRight.w * 0.5 + vec2f(0.5, 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  let mapSize = godRaysParams.tuning.y;
  let texel = clamp(vec2<i32>(floor(uv * vec2f(f32(mapSize)))), vec2<i32>(0i), vec2<i32>(i32(mapSize) - 1i));
  let stored = textureLoad(shadowMap, texel, 0).x;
  return select(0.0, 1.0, stored >= basisW - godRaysParams.shadowBasisForward.w);
}
@group(0) @binding(0) var sourceDepth: texture_2d<f32>;
@group(0) @binding(1) var shadowMap: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> godRaysParams: GodRaysParams;
@group(0) @binding(3) var scatterTarget: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8)
fn marchVolumetricGodRays(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= godRaysParams.scatterSize.x || id.y >= godRaysParams.scatterSize.y) { return; }
  // 半分辨率线程取 2x2 block 内的奇数像素,与体积雾/AO/SSR 的采样约定一致。
  let coordinate = min(id.xy * 2u + vec2<u32>(1u), godRaysParams.sourceSize - vec2<u32>(1u));
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(coordinate), 0).x;
  let tanHalfFov = godRaysParams.projection.x;
  let aspect = godRaysParams.projection.y;
  let baseExtinction = godRaysParams.medium.x;
  let scaleHeight = godRaysParams.medium.y;
  let anisotropy = godRaysParams.medium.z;
  let albedo = godRaysParams.medium.w;
  let ndc = ndcAt(coordinate);
  let rayUnit = vec3f(ndc.x * tanHalfFov * aspect, ndc.y * tanHalfFov, -1.0);
  let rayDirection = normalize(rayUnit);
  // 几何像素步进到深度重建位置;天空像素步进到 maxDistance(与雾核同一分支)。
  let marchDistance = select(godRaysParams.lightDirection.w,
    length(reconstructPosition(coordinate, centerDepth)), centerDepth > 0.0);
  if (!(marchDistance > 0.0)) { textureStore(scatterTarget, vec2<i32>(id.xy), vec4f(0.0, 0.0, 0.0, 1.0)); return; }
  let lightDirection = normalize(godRaysParams.lightDirection.xyz);
  let cosTheta = dot(rayDirection, lightDirection);
  let phase = henyeyGreensteinPhase(cosTheta, anisotropy);
  let stepLength = marchDistance / f32(godRaysParams.tuning.x);
  var inscatter = vec3f(0.0, 0.0, 0.0);
  var transmittance = 1.0;
  // 中点采样 + Beer-Lambert 积分,公式与求值顺序同 CPU 镜像 marchVolumetricGodRaysPassCpu:
  // height = rayDirection.y * distance(相机在视图空间原点)。
  // 每步中点采样阴影图遮挡(C18 对雾核切片一 shadow ≡ 1 的后继),乘子序:
  // scattering = albedo * opticalDepth * phase * shadow;strength 乘在 radiance 侧。
  for (var step = 0u; step < godRaysParams.tuning.x; step++) {
    let distance = (f32(step) + 0.5) * stepLength;
    let height = rayDirection.y * distance;
    let opticalDepth = densityAtHeight(height, baseExtinction, scaleHeight) * stepLength;
    if (opticalDepth < GOD_RAYS_EPSILON) { continue; }
    let extinction = exp(-opticalDepth);
    let shadow = shadowVisibility(rayDirection * distance);
    let scattering = albedo * opticalDepth * phase * shadow;
    inscatter += (godRaysParams.lightRadiance.xyz * godRaysParams.lightRadiance.w) * (scattering * transmittance);
    transmittance *= extinction;
    if (transmittance < GOD_RAYS_TRANSMITTANCE_FLOOR) { break; }
  }
  textureStore(scatterTarget, vec2<i32>(id.xy), vec4f(inscatter, transmittance));
}
