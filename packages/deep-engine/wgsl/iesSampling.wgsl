const DEEP_IES_RAD_TO_DEG: f32 = 57.29577951308232;
const DEEP_IES_ROW_STRIDE: u32 = 91u;
// E02 采样次序合同（iesShading.evaluateIesShadingFactor 同式，round 输入非负）：
// θ/φ 由方向向量推导后量化到 0.5° 网格，φ 减旋转、floor 模 360、对称折叠后取行；
// 列 = θ 的半度数直取（展开表已内化最近邻与角域外为 0）。params.x = -1 → 恒等 1.0。
fn deepSpotIesFactor(spotIndex: u32, surfaceToLightDirection: vec3<f32>, lightDirection: vec3<f32>) -> f32 {
  let params = deepIesShading[spotIndex];
  if (params.x < 0.0) { return 1.0; }
  // meta 是 WGSL 保留字,profile 元数据词用 profileMeta。
  let profileMeta = deepIesShading[u32(params.w)];
  let toSurface = -surfaceToLightDirection;
  let cosTheta = clamp(dot(toSurface, lightDirection), -1.0, 1.0);
  let thetaHalf = clamp(round(acos(cosTheta) * DEEP_IES_RAD_TO_DEG * 2.0), 0.0, 360.0);
  let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(lightDirection.y) > 0.999);
  let right = normalize(cross(up, lightDirection));
  let pole = cross(lightDirection, right);
  var phi = atan2(dot(toSurface, pole), dot(toSurface, right)) * DEEP_IES_RAD_TO_DEG - params.y * 0.5;
  phi = phi - floor(phi / 360.0) * 360.0;
  var phiHalf = round(phi * 2.0);
  if (phiHalf >= 720.0) { phiHalf = 0.0; }
  var gHalf = phiHalf;
  if (profileMeta.w == 2.0 && gHalf > 360.0) { gHalf = 720.0 - gHalf; }
  if (profileMeta.w == 4.0) {
    gHalf = gHalf % 360.0;
    if (gHalf > 180.0) { gHalf = 360.0 - gHalf; }
  }
  var rowHalf = 0.0;
  if (profileMeta.w != 1.0) { rowHalf = clamp(round(gHalf / profileMeta.z), 0.0, profileMeta.y - 1.0); }
  let cell = deepIesShading[u32(profileMeta.x) + u32(rowHalf) * DEEP_IES_ROW_STRIDE + u32(thetaHalf) / 4u];
  // 列选择:θ 半度数直取 + 尾部 vec4 对齐。此前的嵌套 select 链在 naga→SPIR-V
  // (Vulkan 真机腿)被误编译:u32(thetaHalf)%4==3 时仍返回 cell.x(2026-10-07
  // megaLights GPU 探针逐中间量抓出:θ=71、cell.w=1.0、嵌套 select 返 0.8)。
  // 改写为互斥 if 阶梯——求值顺序与取值语义逐位等价,DX12/HLSL 与 Dawn/tint 不变;
  // 与 28312073 continue→if 同一 naga 结构化改写先例。
  let thetaSlot = u32(thetaHalf) % 4u;
  var value = cell.x;
  if (thetaSlot == 1u) { value = cell.y; }
  if (thetaSlot == 2u) { value = cell.z; }
  if (thetaSlot == 3u) { value = cell.w; }
  return value * params.z;
}
