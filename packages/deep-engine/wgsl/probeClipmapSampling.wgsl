
struct DeepGiProbeRecord {
  irradianceValidity: vec4f,
  visibility: vec4f,
  relocation: vec4f,
  reserved0: vec4f,
  reserved1: vec4f,
  reserved2: vec4f,
};
struct DeepGiLevel {
  originSpacing: vec4f,
  gridSize: vec3u,
  level: u32,
  originCell: vec3i,
  baseProbe: u32,
  maxPosition: vec3f,
  probeCount: u32,
};
struct DeepGiLevelSample { irradiance: vec3f, weight: f32 };
@group(3) @binding(9)
var<storage, read> deepGiProbeRecords: array<DeepGiProbeRecord>;
@group(3) @binding(10)
var<storage, read> deepGiLevels: array<DeepGiLevel>;

fn deepGiFinite3(value: vec3f, limit: f32) -> bool {
  return all(value == value) && all(abs(value) <= vec3f(limit));
}
fn deepGiLevelUsable(level: DeepGiLevel) -> bool {
  return level.originSpacing.w > 0.0 && level.originSpacing.w <= 1000000.0
    && deepGiFinite3(level.originSpacing.xyz, 1000000000.0)
    && deepGiFinite3(level.maxPosition, 1000000000.0)
    && all(level.gridSize >= vec3u(2u)) && all(level.gridSize <= vec3u(64u));
}
fn deepGiContains(level: DeepGiLevel, worldPosition: vec3f) -> bool {
  return deepGiLevelUsable(level) && all(worldPosition >= level.originSpacing.xyz)
    && all(worldPosition <= level.maxPosition);
}
// Chebyshev 可见性(F5-GI-1 合同收紧,TS/Rust CPU 镜像逐式同步):
// 记录语义单一来源 = probeOcclusionRayExtension:visibility.x = 命中射线距离均值,
// visibility.y = 命中距离总体方差,visibility.z = miss 方向占比(occlusionFloor)。
// == 均值分支的适用边界 == "receiver 近于均值命中距离 → 无遮挡视线"只在记录自证
// 封闭包络时成立(无天空方向:floor≈0,且命中离散不超过包络尺度)。天空探针的均值
// 不含天空方向,不能证明 receiver 方向无遮挡——薄墙可在均值以内但被中间几何遮挡,
// 必须走 Chebyshev 遮挡估计,不得无条件全权重。floor 是"探针内容里环境光占比"的
// 内容限定符,不构成 receiver 链路的权重下界(否则天空探针隔着墙也保底漏光)。
fn deepGiVisibility(record: DeepGiProbeRecord, receiver: vec3f, probePosition: vec3f, spacing: f32) -> f32 {
  if (!deepGiFinite3(record.visibility.xyz, 1000000000000.0)) { return 0.0; }
  let distance = length(receiver - probePosition);
  let meanDistance = clamp(record.visibility.x, 0.0, 1000000.0);
  let variance = clamp(record.visibility.y, spacing * spacing * 0.0001, 1000000000000.0);
  let occlusionFloor = clamp(record.visibility.z, 0.0, 1.0);
  let enclosed = occlusionFloor <= 0.001
    && variance <= max(meanDistance * meanDistance, spacing * spacing);
  let delta = abs(distance - meanDistance);
  let chebyshev = variance / max(variance + delta * delta, 0.000001);
  return select(chebyshev, 1.0, distance <= meanDistance && enclosed);
}
// DDGI 法线权重（泄漏抑制，逐式对应 probeClipmapSampling.probeNormalWeight）：
// 只让接收面的正半球探针参与，并按余弦的 bias 次幂衰减。
// 半球判断使用原始着色点（worldPosition），不使用偏置后的 receiver；偏置只用于
// 可见性测试，若用偏置点判断半球，网格边缘朝外表面会错误拒绝所有探针。
fn deepGiNormalWeight(probePosition: vec3f, shadingPoint: vec3f, normal: vec3f) -> f32 {
  let toProbe = probePosition - shadingPoint;
  let lengthToProbe = length(toProbe);
  if (!(lengthToProbe > 0.000001)) { return 1.0; }
  let cosine = dot(toProbe, normal) / lengthToProbe;
  if (!(cosine > 0.0)) { return 0.0; }
  return pow(cosine, 3.0);
}
fn deepGiSampleLevel(levelIndex: u32, worldPosition: vec3f, worldNormal: vec3f) -> DeepGiLevelSample {
  let level = deepGiLevels[levelIndex];
  if (!deepGiContains(level, worldPosition)) { return DeepGiLevelSample(vec3f(0.0), 0.0); }
  let coordinate = (worldPosition - level.originSpacing.xyz) / level.originSpacing.w;
  let upper = level.gridSize - vec3u(1u);
  let low = min(vec3u(floor(clamp(coordinate, vec3f(0.0), vec3f(upper)))), level.gridSize - vec3u(2u));
  let fraction = clamp(coordinate - vec3f(low), vec3f(0.0), vec3f(1.0));
  let normalLength = length(worldNormal);
  let normal = select(vec3f(0.0, 1.0, 0.0), worldNormal / max(normalLength, 0.000001),
    normalLength > 0.000001 && deepGiFinite3(worldNormal, 1000000.0));
  let receiver = worldPosition + normal * level.originSpacing.w * 0.2;
  let recordCount = arrayLength(&deepGiProbeRecords);
  var irradiance = vec3f(0.0); var totalWeight = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let bits = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let cell = low + bits;
    let axisWeight = mix(vec3f(1.0) - fraction, fraction, vec3f(bits));
    let trilinear = axisWeight.x * axisWeight.y * axisWeight.z;
    let linear = (cell.z * level.gridSize.y + cell.y) * level.gridSize.x + cell.x;
    if (linear >= level.probeCount || level.baseProbe >= recordCount || linear >= recordCount - level.baseProbe) { continue; }
    let record = deepGiProbeRecords[level.baseProbe + linear];
    let validity = record.irradianceValidity.w;
    if (!(validity > 0.0) || !deepGiFinite3(record.irradianceValidity.xyz, 65504.0)
      || !deepGiFinite3(record.relocation.xyz, 1000000.0)) { continue; }
    let probePosition = level.originSpacing.xyz + vec3f(cell) * level.originSpacing.w + record.relocation.xyz;
    let weight = trilinear * clamp(validity, 0.0, 1.0)
      * deepGiVisibility(record, receiver, probePosition, level.originSpacing.w)
      * deepGiNormalWeight(probePosition, worldPosition, normal);
    irradiance += max(record.irradianceValidity.xyz, vec3f(0.0)) * weight; totalWeight += weight;
  }
  if (!(totalWeight >= 0.001)) { return DeepGiLevelSample(vec3f(0.0), 0.0); }
  return DeepGiLevelSample(clamp(irradiance / totalWeight, vec3f(0.0), vec3f(65504.0)), totalWeight);
}
fn deepGiBoundaryCells(level: DeepGiLevel, worldPosition: vec3f) -> f32 {
  let coordinate = (worldPosition - level.originSpacing.xyz) / level.originSpacing.w;
  let edge = min(coordinate, vec3f(level.gridSize - vec3u(1u)) - coordinate);
  return min(edge.x, min(edge.y, edge.z));
}
fn deepGiSample(worldPosition: vec3f, worldNormal: vec3f, environmentFallback: vec3f) -> vec3f {
  var fallback = vec3f(0.0);
  if (deepGiFinite3(environmentFallback, 65504.0)) { fallback = max(environmentFallback, vec3f(0.0)); }
  if (!deepGiFinite3(worldPosition, 1000000000.0)) { return fallback; }
  let levelCount = min(arrayLength(&deepGiLevels), 4u); var selected = levelCount;
  for (var levelIndex = 0u; levelIndex < levelCount; levelIndex++) {
    if (deepGiContains(deepGiLevels[levelIndex], worldPosition)) { selected = levelIndex; break; }
  }
  if (selected == levelCount) { return fallback; }
  let fine = deepGiSampleLevel(selected, worldPosition, worldNormal);
  if (selected + 1u < levelCount && deepGiContains(deepGiLevels[selected + 1u], worldPosition)) {
    let coarse = deepGiSampleLevel(selected + 1u, worldPosition, worldNormal);
    if (fine.weight >= 0.001 && coarse.weight >= 0.001) {
      let blend = 1.0 - smoothstep(0.0, 1.5,
        deepGiBoundaryCells(deepGiLevels[selected], worldPosition));
      return mix(fine.irradiance, coarse.irradiance, blend);
    }
    if (coarse.weight >= 0.001) { return coarse.irradiance; }
  }
  if (fine.weight >= 0.001) { return fine.irradiance; }
  return fallback;
}
