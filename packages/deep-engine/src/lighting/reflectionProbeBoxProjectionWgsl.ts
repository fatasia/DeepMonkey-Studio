// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/reflectionProbeBoxProjection.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/lighting/reflectionProbeBoxProjectionWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍;无 Rust 半,纯 TS 消费)。

/**
 * I 级 C15 反射探针盒投影视差校正家族的生成镜像。唯一真源
 * wgsl/reflectionProbeBoxProjection.wgsl,纯 TS 消费(无 Rust 半);
 * 纯函数库,无绑定声明,宿主模板组合同 DEEP_AREA_LIGHTING 家族。
 * 哨兵/阈值与 reflectionProbeParallax.ts(CPU 镜像与数据面)互钉。
 */

/** ABI 版本:struct 布局、哨兵值或公式语义变化时递增并同步 CPU 镜像。 */
export const DEEP_REFLECTION_PROBE_ABI_VERSION = 1;
/** 单探针完整 record 字节数(center/blend + extents/radius + captureOffset/generation + reserved)。 */
export const DEEP_REFLECTION_PROBE_RECORD_BYTES = 64;
/** 着色端最小盒描述字节数(DeepReflectionProbeBox:两个 vec4f)。 */
export const DEEP_REFLECTION_PROBE_BOX_BYTES = 32;
/** 双探针插值的次级权重裁剪阈(低于则退化为单探针)。 */
export const DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF = 0.01;
/** 方向零向量判据(与 WGSL 字面量互钉)。 */
export const DEEP_REFLECTION_PROBE_DIRECTION_EPSILON = 0.000001;
/** 不校正哨兵:接收点在影响体 AABB 外(与 influenceWeight>0 同判据)。 */
export const DEEP_REFLECTION_PROBE_SENTINEL_OUTSIDE = -1;
/** 不校正哨兵:输入退化(方向零/非有限、AABB 非法)。 */
export const DEEP_REFLECTION_PROBE_SENTINEL_DEGENERATE = -2;
/** 不约束轴的出射步长哨兵(参加 min 但必不命中)。 */
export const DEEP_REFLECTION_PROBE_UNCONSTRAINED_STEP = 1000000000;

/** 反射探针盒投影视差校正核(真源 wgsl/reflectionProbeBoxProjection.wgsl)。 */
export const DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL = /* wgsl */ "// C15 反射探针盒投影视差校正核(唯一真源,TS 镜像由 scripts/syncSharedWgsl.mjs 生成,\n// 纯 TS 消费,无 Rust 半)。修改流程:改本文件 → pnpm --filter @bim-studio/deep-engine wgsl:sync\n// → 提交 .wgsl + 生成镜像 + .sha256 三件套(三者不同步时字节门禁测试失败)。\n//\n// 为什么需要盒投影:环境 cubemap 以探针中心为视点捕获,\"被反射内容在无穷远\"的采样假设\n// 只对接收点=探针中心成立。接收点偏离中心时,直接用世界反射向量采样会把本应来自有限\n// 距离墙面的内容采到错误方向——表现为反射内容随接收点平移而错位(平面探针反射错位)。\n// 盒投影把反射射线与探针影响体 AABB 求交,用交点相对探针中心的方向替代原始反射向量\n// (Lagarde \"Parallax-corrected Cubemaps\"/Unity/three.js 同式),恢复正确视差。\n//\n// 这是 SSR miss 探针回退链(T03 反射融合)上的增量核,不是第二套反射:宿主在既有\n// specularEnvironment 采样点前用本核校正方向,cubemap 纹理、mip 链与回退语义不变。\n//\n// 纯函数库:无绑定声明,资源由宿主模板提供(group0/binding3 specularEnvironment 等),\n// 组合方式同 DEEP_AREA_LIGHTING_WGSL 家族。数值纪律与 probeClipmapSampling.wgsl 同族:\n// 非有限输入守卫、退化几何显式回退哨兵,不产生静默 NaN。\n\nstruct DeepReflectionProbeBox {\n  center: vec3f,\n  blendDistance: f32,\n  halfExtents: vec3f,\n  influenceRadius: f32,\n};\n\nfn deepReflectionProbeFinite3(value: vec3f, limit: f32) -> bool {\n  return all(value == value) && all(abs(value) <= vec3f(limit));\n}\n\n// 影响体权重(双探针插值的权重核):影响体 = AABB 沿各轴外扩 influenceRadius;\n// 过渡壳 = 影响体边界向内厚 blendDistance 的壳层。AABB 核内权重 1,壳内线性衰减,\n// 影响体外 0;blendDistance=0 退化为边界硬切换(代际切换语义)。非法输入一律回 0。\nfn deepReflectionProbeInfluenceWeight(worldPosition: vec3f, probe: DeepReflectionProbeBox) -> f32 {\n  if (!deepReflectionProbeFinite3(worldPosition, 1000000000.0)\n    || !deepReflectionProbeFinite3(probe.center, 1000000000.0)\n    || !deepReflectionProbeFinite3(probe.halfExtents, 1000000000.0)\n    || any(probe.halfExtents <= vec3f(0.0))) { return 0.0; }\n  let outside = length(max(abs(worldPosition - probe.center) - probe.halfExtents, vec3f(0.0)));\n  if (!(outside < probe.influenceRadius)) { return 0.0; }\n  let shell = min(max(probe.blendDistance, 0.0), probe.influenceRadius);\n  let core = max(probe.influenceRadius - shell, 0.0);\n  return select(1.0 - (outside - core) / max(probe.influenceRadius - core, 0.000001), 1.0, outside <= core);\n}\n\n// 双探针插值归一:输入两个候选权重,返回归一化后 (primary, secondary)。\n// 次级低于裁剪阈(建议 DEEP_REFLECTION_PROBE_SECONDARY_CUTOFF)只保留主探针(归一 (1,0));\n// 两权重之和不足裁剪阈返回 (0,0)——无覆盖,宿主走纯环境回退,禁止负权重进混合。\nfn deepReflectionProbePairWeights(primaryWeight: f32, secondaryWeight: f32, secondaryCutoff: f32) -> vec2f {\n  let primary = select(primaryWeight, 0.0, !(primaryWeight > 0.0));\n  let secondary = select(secondaryWeight, 0.0, !(secondaryWeight > 0.0));\n  if (!(primary + secondary >= secondaryCutoff)) { return vec2f(0.0, 0.0); }\n  let secondaryKept = select(secondary, 0.0, secondary < secondaryCutoff);\n  let keptTotal = primary + secondaryKept;\n  return vec2f(primary / keptTotal, secondaryKept / keptTotal);\n}\n\n// 盒投影校正。返回 xyz = 校正后采样方向(单位向量,相对 cubemap 中心),w = 接收点→\n// 影响体面交点的距离。w < 0 = 不校正,宿主回退原始反射向量(与未接本核的既有路径同语义):\n//   -1: 接收点在影响体 AABB 外——校正的正确域就是影响体内部,与 influenceWeight>0 同判据;\n//   -2: 输入退化(方向零/非有限、AABB 非法)。\n// 接收点在盒内时逐轴出射步长 t = (±e − p)/d(按 d 符号选面)恒 > 0;某轴 |d|≈0 且接收点\n// 在该板内 = 该板不约束(哨兵 1e9 参加取 min 但必不命中)。接收点恰在面上时 t 可为 0,\n// 交点仍在面上、长度不为零,normalize 无 NaN 路径。\nfn deepReflectionProbeBoxProject(worldPosition: vec3f, reflectionDirection: vec3f, probe: DeepReflectionProbeBox) -> vec4f {\n  let directionLength = length(reflectionDirection);\n  if (!(directionLength > 0.000001) || !deepReflectionProbeFinite3(reflectionDirection, 1000000000.0)\n    || !deepReflectionProbeFinite3(worldPosition, 1000000000.0)\n    || !deepReflectionProbeFinite3(probe.center, 1000000000.0)\n    || !deepReflectionProbeFinite3(probe.halfExtents, 1000000000.0)\n    || any(probe.halfExtents <= vec3f(0.0))) { return vec4f(reflectionDirection, -2.0); }\n  let relative = worldPosition - probe.center;\n  if (any(abs(relative) > probe.halfExtents)) { return vec4f(reflectionDirection, -1.0); }\n  let direction = reflectionDirection / directionLength;\n  let constrained = abs(direction) >= vec3f(0.000001);\n  let bound = select(vec3f(0.0) - probe.halfExtents, probe.halfExtents, direction > vec3f(0.0));\n  let axisStep = select(vec3f(1000000000.0), (bound - relative) / direction, constrained);\n  let exitDistance = min(axisStep.x, min(axisStep.y, axisStep.z));\n  let corrected = relative + direction * exitDistance;\n  return vec4f(normalize(corrected), exitDistance);\n}\n";
