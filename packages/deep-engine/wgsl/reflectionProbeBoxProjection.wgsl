// C15 反射探针盒投影视差校正核(唯一真源,TS 镜像由 scripts/syncSharedWgsl.mjs 生成,
// 纯 TS 消费,无 Rust 半)。修改流程:改本文件 → pnpm --filter @bim-studio/deep-engine wgsl:sync
// → 提交 .wgsl + 生成镜像 + .sha256 三件套(三者不同步时字节门禁测试失败)。
//
// 为什么需要盒投影:环境 cubemap 以探针中心为视点捕获,"被反射内容在无穷远"的采样假设
// 只对接收点=探针中心成立。接收点偏离中心时,直接用世界反射向量采样会把本应来自有限
// 距离墙面的内容采到错误方向——表现为反射内容随接收点平移而错位(平面探针反射错位)。
// 盒投影把反射射线与探针影响体 AABB 求交,用交点相对探针中心的方向替代原始反射向量
// (Lagarde "Parallax-corrected Cubemaps"/Unity/three.js 同式),恢复正确视差。
//
// 这是 SSR miss 探针回退链(T03 反射融合)上的增量核,不是第二套反射:宿主在既有
// specularEnvironment 采样点前用本核校正方向,cubemap 纹理、mip 链与回退语义不变。
//
// 纯函数库:无绑定声明,资源由宿主模板提供(group0/binding3 specularEnvironment 等),
// 组合方式同 DEEP_AREA_LIGHTING_WGSL 家族。数值纪律与 probeClipmapSampling.wgsl 同族:
// 非有限输入守卫、退化几何显式回退哨兵,不产生静默 NaN。

struct DeepReflectionProbeBox {
  center: vec3f,
  blendDistance: f32,
  halfExtents: vec3f,
  influenceRadius: f32,
};

fn deepReflectionProbeFinite3(value: vec3f, limit: f32) -> bool {
  return all(value == value) && all(abs(value) <= vec3f(limit));
}

// 影响体权重(双探针插值的权重核):影响体 = AABB 沿各轴外扩 influenceRadius;
// 过渡壳 = 影响体边界向内厚 blendDistance 的壳层。AABB 核内权重 1,壳内线性衰减,
// 影响体外 0;blendDistance=0 退化为边界硬切换(代际切换语义)。非法输入一律回 0。
fn deepReflectionProbeInfluenceWeight(worldPosition: vec3f, probe: DeepReflectionProbeBox) -> f32 {
  if (!deepReflectionProbeFinite3(worldPosition, 1000000000.0)
    || !deepReflectionProbeFinite3(probe.center, 1000000000.0)
    || !deepReflectionProbeFinite3(probe.halfExtents, 1000000000.0)
    || any(probe.halfExtents <= vec3f(0.0))) { return 0.0; }
  let outside = length(max(abs(worldPosition - probe.center) - probe.halfExtents, vec3f(0.0)));
  if (!(outside < probe.influenceRadius)) { return 0.0; }
  let shell = min(max(probe.blendDistance, 0.0), probe.influenceRadius);
  let core = max(probe.influenceRadius - shell, 0.0);
  return select(1.0 - (outside - core) / max(probe.influenceRadius - core, 0.000001), 1.0, outside <= core);
}

// 双探针插值归一:输入两个候选权重,返回归一化后 (primary, secondary)。
// 次级低于裁剪阈(建议 DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF)只保留主探针(归一 (1,0));
// 两权重之和不足裁剪阈返回 (0,0)——无覆盖,宿主走纯环境回退,禁止负权重进混合。
fn deepReflectionProbePairWeights(primaryWeight: f32, secondaryWeight: f32, secondaryCutoff: f32) -> vec2f {
  let primary = select(primaryWeight, 0.0, !(primaryWeight > 0.0));
  let secondary = select(secondaryWeight, 0.0, !(secondaryWeight > 0.0));
  if (!(primary + secondary >= secondaryCutoff)) { return vec2f(0.0, 0.0); }
  let secondaryKept = select(secondary, 0.0, secondary < secondaryCutoff);
  let keptTotal = primary + secondaryKept;
  return vec2f(primary / keptTotal, secondaryKept / keptTotal);
}

// 盒投影校正。返回 xyz = 校正后采样方向(单位向量,相对 cubemap 中心),w = 接收点→
// 影响体面交点的距离。w < 0 = 不校正,宿主回退原始反射向量(与未接本核的既有路径同语义):
//   -1: 接收点在影响体 AABB 外——校正的正确域就是影响体内部,与 influenceWeight>0 同判据;
//   -2: 输入退化(方向零/非有限、AABB 非法)。
// 接收点在盒内时逐轴出射步长 t = (±e − p)/d(按 d 符号选面)恒 > 0;某轴 |d|≈0 且接收点
// 在该板内 = 该板不约束(哨兵 1e9 参加取 min 但必不命中)。接收点恰在面上时 t 可为 0,
// 交点仍在面上、长度不为零,normalize 无 NaN 路径。
fn deepReflectionProbeBoxProject(worldPosition: vec3f, reflectionDirection: vec3f, probe: DeepReflectionProbeBox) -> vec4f {
  let directionLength = length(reflectionDirection);
  if (!(directionLength > 0.000001) || !deepReflectionProbeFinite3(reflectionDirection, 1000000000.0)
    || !deepReflectionProbeFinite3(worldPosition, 1000000000.0)
    || !deepReflectionProbeFinite3(probe.center, 1000000000.0)
    || !deepReflectionProbeFinite3(probe.halfExtents, 1000000000.0)
    || any(probe.halfExtents <= vec3f(0.0))) { return vec4f(reflectionDirection, -2.0); }
  let relative = worldPosition - probe.center;
  if (any(abs(relative) > probe.halfExtents)) { return vec4f(reflectionDirection, -1.0); }
  let direction = reflectionDirection / directionLength;
  let constrained = abs(direction) >= vec3f(0.000001);
  let bound = select(vec3f(0.0) - probe.halfExtents, probe.halfExtents, direction > vec3f(0.0));
  let axisStep = select(vec3f(1000000000.0), (bound - relative) / direction, constrained);
  let exitDistance = min(axisStep.x, min(axisStep.y, axisStep.z));
  let corrected = relative + direction * exitDistance;
  return vec4f(normalize(corrected), exitDistance);
}
