// WGSL 单源(试点)同步器:唯一真源是 packages/deep-engine/wgsl/ 下的 .wgsl 文件,
// 本脚本从真源生成(a)TS 镜像模块、(b)SHA-256 校验和夹具(“<hex> <byteLen>”单行)。
// Rust 侧不经本脚本——deep-engine-native/src/probe_gi_wgsl.rs 用 include_str! 直接引用真源。
//
// 为什么 TS 侧是“生成镜像”而不是 ?raw 直读:根入口 src/index.ts `export * from "./lighting/index.js"`
// 使 WGSL 模块进入 apps/api 的 node/tsx 消费链,而 `?raw` 仅 Vite/vitest 支持;
// 镜像由 JSON.stringify 逐字节转写,运行时仍是普通 TS 字符串(node/dist/tsx 全兼容),
// 字节一致性由 probeClipmapSamplingWgslChecksum.test.ts(staleness + checksum)与 Rust 半对拍守护。
//
// 修改 WGSL 的流程:改 wgsl/<name>.wgsl → `pnpm --filter @bim-studio/deep-engine wgsl:sync`
// → 提交 .wgsl + 生成模块 + .sha256 夹具(三者不同步时 TS/Rust 两半测试都会失败)。
// 推广新 WGSL 家族:把文件放入 wgsl/ 并在 SHARED_WGSL 登记一项。
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wgslRoot = resolve(packageRoot, "wgsl");

/** 单源登记表:真源 .wgsl → 生成目标。 */
const SHARED_WGSL = [
  { source: "materialMetalReflection.wgsl",
    module: resolve(packageRoot, "src/shader/materialMetalReflectionWgsl.ts"),
    gate: "src/shader/materialMetalReflectionWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/native_mesh_wgsl.rs", constants: "",
    preamble: `export const MATERIAL_METAL_REFLECTION_WGSL = /* wgsl */ `,
  },
  { source: "materialEvaluateCore.wgsl",
    module: resolve(packageRoot, "src/shader/materialEvaluateCoreWgsl.ts"),
    gate: "src/shader/materialEvaluateCoreWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs", constants: "",
    preamble: `export const EXTENDED_MATERIAL_CORE_WGSL = /* wgsl */ `,
  },
  {
    source: "probeClipmapSampling.wgsl",
    module: resolve(packageRoot, "src/lighting/probeClipmapSamplingWgsl.ts"),
    // ABI 常量与真源插值点的字面一致性由 probeClipmapSamplingWgslChecksum.test.ts 守护。
    gate: "src/lighting/probeClipmapSamplingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/probe_gi_wgsl.rs",
    constants: `export const DEEP_GI_SAMPLING_ABI_VERSION = 1;
export const DEEP_GI_SAMPLING_BIND_GROUP = 3;
export const DEEP_GI_PROBE_STORAGE_BINDING = 9;
export const DEEP_GI_LEVEL_METADATA_BINDING = 10;
export const DEEP_GI_PROBES_PER_LEVEL_SAMPLE = 8;
export const DEEP_GI_MAX_LEVEL_SAMPLE_COUNT = 2;
export const DEEP_GI_MAX_PROBE_FETCHES = 16;
export const DEEP_GI_CASCADE_BLEND_CELLS = 1.5;
export const DEEP_GI_NORMAL_BIAS_CELLS = 0.2;
/** DDGI 法线权重陡峭度：越大越抑制斜向（背面）探针，是泄漏抑制的主控参数。 */
export const DEEP_GI_NORMAL_WEIGHT_BIAS = 3;
export const DEEP_GI_MIN_SAMPLE_WEIGHT = 0.001;
`,
    preamble: `/** Read-only group-3 library; resource binding is deferred until the GI renderer slice. */\nexport const PROBE_CLIPMAP_SAMPLING_WGSL = /* wgsl */ `,
  },
  {
    // J2-B1 家族一:介电 F0。文件内容 = 既有 MATERIAL_DIELECTRIC_WGSL 导出串逐字节
    // (首行换行是原模板字面量的一部分,字节冻结——pbrShader.ts 用本串对
    // EXTENDED_MATERIAL_EVALUATION_WGSL 做 .replace() 手术,字节漂移会静默漏替换)。
    source: "materialDielectric.wgsl",
    module: resolve(packageRoot, "src/lighting/materialDielectricWgsl.ts"),
    gate: "src/lighting/materialDielectricWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * J2-B1 介电 F0 家族(灯光数学三件套之一)的生成镜像。唯一真源 wgsl/materialDielectric.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费)。再导出入口:src/materialDielectric.ts(既有 import 路径不变)。
 */`,
    preamble: `export const MATERIAL_DIELECTRIC_WGSL = /* wgsl */ `,
  },
  {
    // J2-B1 家族二:直射 BRDF(GGX + 相关 Smith + Schlick)。文件内容 = PBR_DIRECT_LIGHTING_WGSL
    // 去掉首行换行与介电块后的余部;组合恒等式
    // PBR_DIRECT_LIGHTING_WGSL === "\\n" + MATERIAL_DIELECTRIC_WGSL + "\\n" + 本文件
    // 由 brdfDirectLightingWgslChecksum.test.ts 逐字节锁定。引用 safeNormalize 由宿主提供
    // (native mesh 侧有同名适配别名)。
    source: "brdfDirectLighting.wgsl",
    module: resolve(packageRoot, "src/lighting/brdfDirectLightingWgsl.ts"),
    gate: "src/lighting/brdfDirectLightingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * J2-B1 直射 BRDF 家族的生成镜像。唯一真源 wgsl/brdfDirectLighting.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费)。高光乘法次序 \`f * visibility * distribution\` 是 TS 权威序
 * (白炉验收基准;native 原实现为 distribution 起乘,B1 已对齐,漂移记录见任务报告)。
 */`,
    preamble: `export const PBR_BRDF_DIRECT_LIGHTING_WGSL = /* wgsl */ `,
  },
  {
    // J2-B1 家族三:IES 光域网采样。文件内容 = FORWARD_PLUS_PBR_WGSL 中
    // "const DEEP_IES_RAD_TO_DEG" 起、deepClusterSafeNormalize 前止的连续区段
    // (常量 + 合同注释 + deepSpotIesFactor;原 TS 插值 ${IES_TABLE_ROW_STRIDE_VEC4}u
    // 已固化为 91u 字面量,字面值与 iesShading.ts 常量的锁定在 checksum 测试)。
    // 末尾带换行,TS 侧组合用同行拼接保持 FORWARD_PLUS_PBR_WGSL 逐字节不变。
    source: "iesSampling.wgsl",
    module: resolve(packageRoot, "src/lighting/iesSamplingWgsl.ts"),
    gate: "src/lighting/iesSamplingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * J2-B1 IES 光域网采样家族的生成镜像。唯一真源 wgsl/iesSampling.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(bin 侧 frame_bindings 经 concat! 拼进
 * native mesh shader 真实消费;binding 9 的 storage 变量随源内符号统一为 deepIesShading)。
 */`,
    preamble: `export const DEEP_IES_SAMPLING_WGSL = /* wgsl */ `,
  },
  {
    // C3 矩形/带纹理面积光(LTC)家族。真源 wgsl/ltcAreaLighting.wgsl,
    // Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs(include_str! + 夹具对拍;
    // native 无运行时通路,消费面 = WGSL 单源指纹 + ltc_area_light.rs f64 参考)。
    source: "ltcAreaLighting.wgsl",
    module: resolve(packageRoot, "src/lighting/ltcAreaLightingWgsl.ts"),
    gate: "src/lighting/ltcAreaLightingWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/lighting_math_wgsl.rs",
    constants: `/**
 * C3 面积光 LTC 家族的生成镜像。唯一真源 wgsl/ltcAreaLighting.wgsl,
 * Rust 半在 deep-engine-native/src/lighting_math_wgsl.rs;绑定声明留宿主模板
 * (FORWARD_PLUS_PBR 模板 group3/binding13 storage;常量与 areaLights.ts 互钉)。
 */`,
    preamble: `export const DEEP_AREA_LIGHTING_WGSL = /* wgsl */ `,
  },
  {
    // T18 A3 并行布料 XPBD compute 家族。真源 wgsl/clothSolver.wgsl,
    // Rust 半在 deep-engine-native/tests/cloth_parallel_compute_parity.rs(测试侧
    // include_str! + sidecar/镜像三方对拍)。执行序合同:着色色序 Gauss-Seidel
    // (色间 dispatch 定序、色内端点不相交)+ 三级固定归约树统计;
    // CPU f32 模拟镜像在 src/physics/clothParallelSolver.ts,与真源逐运算同构。
    source: "clothSolver.wgsl",
    module: resolve(packageRoot, "src/physics/clothSolverWgsl.ts"),
    gate: "src/physics/clothSolverWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/tests/cloth_parallel_compute_parity.rs",
    constants: `/**
 * T18 A3 并行布料 compute 家族的生成镜像。唯一真源 wgsl/clothSolver.wgsl,
 * Rust 半在 deep-engine-native/tests/cloth_parallel_compute_parity.rs。
 * 常量与 clothParallelSolver.ts / clothParallelGpuDispatch(后续接线)互钉。
 */

/** workgroup 尺寸:核内三 pass 一致;镜像按同宽切块做共享内存树。 */
export const CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE = 64;
/** 粒子存储步长:vec4f ×3(position+invMass / velocity / previous)。 */
export const CLOTH_PARALLEL_PARTICLE_STRIDE_BYTES = 48;
/** 约束存储步长:a, b, restLength, pad(按色桶排序)。 */
export const CLOTH_PARALLEL_CONSTRAINT_STRIDE_BYTES = 16;
/** 全局参数 uniform 步长(counts×4 + dt/compliance/damping/windEnabled + gravity +
 * windDirection + windSeed/baseSpeed/gustFreq/spatialScale/tickSeconds + obstacleCount/pad×2;
 * F6/T18 风+障碍扩展后 struct 尾对齐 96B。Chrome auto layout 按 struct 全长取
 * minBindingSize,宿主分配必须同步——48B 旧值让 bind group/命令缓冲在 Submit 处
 * 被整体静默丢弃,无异常只有 uncapturederror)。 */
export const CLOTH_PARALLEL_PARAMS_BYTES = 96;
/** 每色 dispatch uniform 步长(rangeStart/rangeEnd/pad×2)。 */
export const CLOTH_PARALLEL_STEP_RANGE_BYTES = 16;
/** compute 入口名(测试与探针按名取 entry point)。 */
export const CLOTH_PARALLEL_ENTRY_INTEGRATE = "integrateParticles";
export const CLOTH_PARALLEL_ENTRY_PROJECT = "projectConstraintsColor";
export const CLOTH_PARALLEL_ENTRY_FINALIZE = "finalizeVelocityKinetics";
`,
    preamble: `export const DEEP_CLOTH_PARALLEL_SOLVER_WGSL = /* wgsl */ `,
  },
  {
    // I 级 C1 3DGS 实景扫描家族。真源 wgsl/gaussianSplatQuads.wgsl,纯 TS 消费
    // (无 Rust 半;instanced quad splatting,EWA 协方差投影,排序在 CPU)。
    // ABI 常量与 src/gaussianSplat/splatGpuResources.ts 的布局常量互钉,
    // 一致性由 splatQuadsWgslChecksum.test.ts 锁定。
    source: "gaussianSplatQuads.wgsl",
    module: resolve(packageRoot, "src/gaussianSplat/splatQuadsWgsl.ts"),
    gate: "src/gaussianSplat/splatQuadsWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/**
 * I 级 C1 3DGS instanced quad splatting 家族的生成镜像。唯一真源
 * wgsl/gaussianSplatQuads.wgsl,纯 TS 消费(无 Rust 半)。
 * 常量与 splatGpuResources.ts(SPLAT_UNIFORM_FLOAT_COUNT 等)互钉。
 */

/** ABI 版本:record 布局或 uniform 结构变化时递增并同步两端。 */
export const DEEP_GAUSSIAN_SPLAT_ABI_VERSION = 2;
/** uniform 绑定组与槽位(group0:binding0 uniform + binding1 storage)。 */
export const DEEP_GAUSSIAN_SPLAT_UNIFORM_BINDING = 0;
export const DEEP_GAUSSIAN_SPLAT_STORAGE_BINDING = 1;
export const DEEP_GAUSSIAN_SPLAT_ORDER_BINDING = 2;
/** 单粒 record 的 vec4f 个数与字节数(CPU 解码产物与 storage 逐字一致)。 */
export const DEEP_GAUSSIAN_SPLAT_RECORD_VEC4_STRIDE = 4;
export const DEEP_GAUSSIAN_SPLAT_RECORD_BYTES = 64;
/** uniform 总字节(view+viewProjection+camera+viewportFocal+controls,176B)。 */
export const DEEP_GAUSSIAN_SPLAT_UNIFORM_BYTES = 176;
/** 渲染入口名(消费侧按名取 entry point)。 */
export const DEEP_GAUSSIAN_SPLAT_ENTRY_VERTEX = "vsMain";
export const DEEP_GAUSSIAN_SPLAT_ENTRY_FRAGMENT = "fsMain";
`,
    preamble: `/** 3DGS instanced quad splatting 渲染着色器(真源 wgsl/gaussianSplatQuads.wgsl)。 */\nexport const GAUSSIAN_SPLAT_QUADS_WGSL = /* wgsl */ `,
  },
  {
    // I 级 C15 反射探针盒投影视差校正家族。真源 wgsl/reflectionProbeBoxProjection.wgsl,
    // 纯 TS 消费(无 Rust 半;纯函数库,无绑定声明,宿主模板组合同 DEEP_AREA_LIGHTING 家族)。
    // 哨兵/阈值常量与 src/lighting/reflectionProbeParallax.ts 的 CPU 镜像互钉,
    // 一致性由 reflectionProbeBoxProjectionWgslChecksum.test.ts 锁定。
    source: "reflectionProbeBoxProjection.wgsl",
    module: resolve(packageRoot, "src/lighting/reflectionProbeBoxProjectionWgsl.ts"),
    gate: "src/lighting/reflectionProbeBoxProjectionWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/**
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
`,
    preamble: `/** 反射探针盒投影视差校正核(真源 wgsl/reflectionProbeBoxProjection.wgsl)。 */\nexport const DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL = /* wgsl */ `,
  },
  {
    // I 级 C23 分层材质混合核。真源 wgsl/materialLayerBlend.wgsl,
    // 纯 TS 消费(无 Rust 半;响应级层栈混合,与 T08 求值核正交)。
    // 共享权重凸混合公式与 materialLayeredEvaluate.ts 的 CPU 闭式互钉,
    // 一致性由 materialLayerBlendWgslChecksum.test.ts 锁定。
    source: "materialLayerBlend.wgsl",
    module: resolve(packageRoot, "src/shader/materialLayerBlendWgsl.ts"),
    gate: "src/shader/materialLayerBlendWgslChecksum.test.ts",
  },
  {
    // A2 WGSL SDF 碰撞 profile 查询核。真源 wgsl/sdfCollisionQuery.wgsl,
    // Rust 半在 deep-engine-native/tests/sdf_collision_profile_truth.rs(测试侧
    // include_str! + sidecar 三方对拍)。合同:每 lane 输出独立(无归约/无原子,
    // 同输入逐位回放);域外 fail-closed(quiet NaN + status=1,宿主整批拒绝);
    // 误差边界 vs Rapier 凸包真值由 sdfCollisionProfile.ts 逐字段守护。
    source: "sdfCollisionQuery.wgsl",
    module: resolve(packageRoot, "src/physics/sdfCollisionQueryWgsl.ts"),
    gate: "src/physics/sdfCollisionQueryWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/tests/sdf_collision_profile_truth.rs",
    constants: `/**
 * A2 SDF 碰撞 profile 查询核的生成镜像。唯一真源 wgsl/sdfCollisionQuery.wgsl,
 * Rust 半在 deep-engine-native/tests/sdf_collision_profile_truth.rs。
 * 常量与 sdfCollisionProfile.ts(打包/解包/预算)互钉。
 */

/** workgroup 尺寸:每 lane 独立处理一条查询点,无跨 lane 通信。 */
export const SDF_QUERY_WORKGROUP_SIZE = 64;
/** uniform 总字节(origin 12 + cellSize 4 + dimensions 12 + count 4 + contactSkin 4 + pad 12)。 */
export const SDF_QUERY_PARAMS_BYTES = 48;
/** compute 入口名(测试与探针按名取 entry point)。 */
export const SDF_QUERY_ENTRY = "queryCollisions";
/** lane 状态字:0 = 域内;1 = 域外(fail-closed,宿主见到任何非 0 整批拒绝)。 */
export const SDF_QUERY_STATUS_IN_DOMAIN = 0;
export const SDF_QUERY_STATUS_OUT_OF_DOMAIN = 1;
/** quiet NaN 位型(域外 distance 信号;field 本身永不含 NaN,双向可判)。 */
export const SDF_QUERY_NAN_BITS = 0x7fc00000;
/** 单批查询点上限(与 sdfGpuQuery 同源;内存预算由此有界)。 */
export const SDF_QUERY_MAX_POINTS = 65536;
`,
    preamble: `/** SDF 碰撞 profile 查询核:trilinear 距离 + 中心差分梯度 + 域外 fail-closed(真源 wgsl/sdfCollisionQuery.wgsl)。 */\nexport const DEEP_SDF_COLLISION_QUERY_WGSL = /* wgsl */ `,
  },
  {
    // Brief-GI M1 天光遮蔽核(2026-10-04)。真源 wgsl/sdfSkyVisibilityTrace.wgsl,
    // 纯 TS 消费(无 Rust 半;每 lane 一个探针方向 × 场景 SDF 圆锥追踪)。
    // 合同:固定步数无 early-break(同输入逐位回放);域外 fail-open=1(光照量,
    // 非安全量,刻意与碰撞查询的 fail-closed NaN 不同);CPU 镜像在
    // src/gi/sdfSkyVisibility.ts(同序 fround),一致性由
    // sdfSkyVisibilityTraceWgslChecksum.test.ts 锁定。
    source: "sdfSkyVisibilityTrace.wgsl",
    module: resolve(packageRoot, "src/gi/sdfSkyVisibilityTraceWgsl.ts"),
    gate: "src/gi/sdfSkyVisibilityTraceWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/**
 * Brief-GI M1 天光遮蔽核的生成镜像。唯一真源 wgsl/sdfSkyVisibilityTrace.wgsl,
 * 纯 TS 消费(无 Rust 半)。常量与 sdfSkyVisibility.ts(打包/镜像)互钉。
 */

/** workgroup 尺寸:每 lane 独立处理一条 (探针 × 方向),无跨 lane 通信。 */
export const SDF_SKY_VISIBILITY_WORKGROUP_SIZE = 64;
/** uniform 总字节(origin 12 + cellSize 4 + dimensions 12 + steps 4 + coneTan 4 + maxDistance 4 + directionCount 4 + probeCount 4)。 */
export const SDF_SKY_VISIBILITY_PARAMS_BYTES = 48;
/** compute 入口名(测试与宿主按名取 entry point)。 */
export const SDF_SKY_VISIBILITY_ENTRY = "traceSkyVisibility";
/** 圆锥步数下限/上限(Brief-GI:8..16 步)。 */
export const SDF_SKY_VISIBILITY_MIN_STEPS = 8;
export const SDF_SKY_VISIBILITY_MAX_STEPS = 16;
/** 圆锥 limit 的除法下限(max(coneTan·t, 该值)),防 t≈0 除零。 */
export const SDF_SKY_VISIBILITY_LIMIT_EPSILON = 0.000001;
`,
    preamble: `/** 天光遮蔽圆锥追踪核:每 lane = 探针方向 × 场景 SDF 软阴影口径(真源 wgsl/sdfSkyVisibilityTrace.wgsl)。 */\nexport const DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL = /* wgsl */ `,
  },
  {
    // B2 MegaLights M1 RIS 采样核(2026-10-04)。真源 wgsl/megaLightsRis.wgsl,
    // 纯 TS 消费(无 Rust 半;宿主模板 megaLightsRuntime.ts 组合进 compute pipeline,
    // 绑定声明留宿主,同 ltcAreaLighting 家族纪律)。互钉常量在 megaLights.ts
    // (64B/灯 ABI、K=32、空间半径 2、历史钳 20、相似门)与 megaLightsAbi.ts
    // (绑定槽位/参数字级布局),一致性由 megaLightsRisWgslChecksum.test.ts 锁定;
    // CPU 权威镜像在 megaLightsRisCpu.ts(同式同序,验收②④⑤真值端)。
    source: "megaLightsRis.wgsl",
    module: resolve(packageRoot, "src/lighting/megaLightsRisWgsl.ts"),
    gate: "src/lighting/megaLightsRisWgslChecksum.test.ts",
    rustHalf: null,
    constants: "",
    preamble: `/** MegaLights RIS 采样核(真源 wgsl/megaLightsRis.wgsl;绑定留宿主模板)。 */\nexport const MEGA_LIGHTS_RIS_WGSL = /* wgsl */ `,
  },
  {
    // I 级 C17 节点化/流场粒子首刀家族。真源 wgsl/particleFlowField.wgsl,纯 TS 消费
    // (无 Rust 半;curl-noise 流场驱动的粒子 compute 核,绑定 0..5 与既有粒子核同构,
    // 新增 binding 6 流场 uniform)。常量与 gpuParticleFlowFieldTypes.ts(打包/校验)
    // 与 flowFieldNoise.ts(CPU f32 逐运算镜像)互钉,一致性由
    // gpuParticleFlowFieldWgslChecksum.test.ts 锁定。
    source: "particleFlowField.wgsl",
    module: resolve(packageRoot, "src/webgpu/gpuParticleFlowFieldWgsl.ts"),
    gate: "src/webgpu/gpuParticleFlowFieldWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/**
 * I 级 C17 流场粒子 compute 家族的生成镜像。唯一真源 wgsl/particleFlowField.wgsl,
 * 纯 TS 消费(无 Rust 半)。常量与 gpuParticleFlowFieldTypes.ts(打包/校验)与
 * flowFieldNoise.ts(CPU f32 逐运算镜像)互钉。
 */

/** ABI 版本:FlowParams 布局、哈希常量或公式语义变化时递增并同步 CPU 镜像。 */
export const GPU_PARTICLE_FLOW_ABI_VERSION = 1;
/** 流场 uniform 总字节(phase/scale/speed/strength + maxSpeed/seed + pad×2)。 */
export const GPU_PARTICLE_FLOW_UNIFORM_BYTES = 32;
/** compute 入口名(运行时与测试按名取 entry point)。 */
export const GPU_PARTICLE_FLOW_ENTRY = "simulateAndCompactFlow";
/** 采样域硬限:f32→i32 格点转换前先钳(越界转换未定义,必须钳)。 */
export const GPU_PARTICLE_FLOW_DOMAIN_LIMIT = 1000000;
/** 势场去相关种子混入量(host 镜像同字面,任何一端漂移都在字节门禁失败)。 */
export const GPU_PARTICLE_FLOW_POTENTIAL_A = 1474034859;
export const GPU_PARTICLE_FLOW_POTENTIAL_B = 645307069;
export const GPU_PARTICLE_FLOW_POTENTIAL_C = 752542313;
`,
    preamble: `/** curl-noise 流场粒子 compute 核(真源 wgsl/particleFlowField.wgsl)。 */\nexport const GPU_PARTICLE_FLOW_FIELD_WGSL = /* wgsl */ `,
  },
  {
    // I 级 C23 分层材质混合核家族。真源 wgsl/materialLayerBlend.wgsl,纯 TS 消费
    // (无 Rust 半;求值响应级 rgb/lobe 逐通道混合,replace/overlay 两种语义)。
    // 常量与 materialLayeredParameters.ts(MATERIAL_LAYER_BLEND_MODE_CODES 等)互钉,
    // 混合闭式与 CPU 参考 materialLayeredEvaluate.blendChannel 逐运算镜像,
    // 一致性由 materialLayerBlendWgslChecksum.test.ts 锁定。
    source: "materialLayerBlend.wgsl",
    module: resolve(packageRoot, "src/shader/materialLayerBlendWgsl.ts"),
    gate: "src/shader/materialLayerBlendWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/**
 * I 级 C23 分层材质混合核家族的生成镜像。唯一真源 wgsl/materialLayerBlend.wgsl,
 * 纯 TS 消费(无 Rust 半)。常量与 materialLayeredParameters.ts 互钉;
 * 混合闭式与 CPU 参考 materialLayeredEvaluate.blendChannel 逐运算镜像。
 */

/** 混合语义 GPU 码(replace=0 / overlay=1),与 MATERIAL_LAYER_BLEND_MODE_CODES 互钉。 */
export const DEEP_LAYER_BLEND_MODE_REPLACE = 0;
export const DEEP_LAYER_BLEND_MODE_OVERLAY = 1;
/** 层栈深度上限,与 MATERIAL_LAYER_MAX_COUNT 互钉。 */
export const DEEP_LAYER_MAX_COUNT = 2;
/** 单层槽 f32 数(6 层参数 + coverage + modeCode),与 MATERIAL_LAYER_FLOAT_COUNT 互钉。 */
export const DEEP_LAYER_SLOT_FLOAT_COUNT = 8;
/** 分层块定长 f32 数(base 6 + 2 层槽 ×8),与 LAYERED_MATERIAL_FLOAT_COUNT 互钉。 */
export const DEEP_LAYERED_BLOCK_FLOAT_COUNT = 22;
`,
    preamble: `/** 分层材质求值响应级混合核(真源 wgsl/materialLayerBlend.wgsl)。 */\nexport const MATERIAL_LAYER_BLEND_WGSL = /* wgsl */ `,
  },
  {
    // I 级 C18 体积光 god rays 家族。真源 wgsl/volumetricGodRays.wgsl,纯 TS 消费
    // (无 Rust 半;完整 compute kernel,与 G7 体积雾核同参数空间,增量 = 每步
    // 阴影图遮挡采样 + strength 乘子)。ABI 常量与 volumetricGodRays.ts/
    // volumetricGodRaysCpu.ts(预算硬顶、光基构造、CPU 镜像)互钉,
    // 一致性由 volumetricGodRaysWgslChecksum.test.ts 锁定。
    source: "volumetricGodRays.wgsl",
    module: resolve(packageRoot, "src/lighting/volumetricGodRaysWgsl.ts"),
    gate: "src/lighting/volumetricGodRaysWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/**
 * I 级 C18 体积光 god rays 家族的生成镜像。唯一真源 wgsl/volumetricGodRays.wgsl,
 * 纯 TS 消费(无 Rust 半)。常量与 volumetricGodRays.ts / volumetricGodRaysCpu.ts
 * (预算硬顶、光空间基、CPU 逐式镜像)互钉。
 */

/** ABI 版本:GodRaysParams 布局、比较语义或公式变化时递增并同步 CPU 镜像。 */
export const DEEP_GOD_RAYS_ABI_VERSION = 1;
/** workgroup 尺寸:与体积雾核同尺寸(8,8)。 */
export const DEEP_GOD_RAYS_WORKGROUP_SIZE = 8;
/** GodRaysParams 的 vec4 槽位数(sourceSize/scatterSize 合占 1 槽 + 8 个 vec4 成员)。 */
export const DEEP_GOD_RAYS_PARAMS_VEC4_COUNT = 9;
/** GodRaysParams 总字节数(9 x 16B = 144B;结构体 16B 对齐)。 */
export const DEEP_GOD_RAYS_PARAMS_BYTES = 144;
/** 深度图未命中 texel 的 FAR 哨兵(与 volumetricGodRays.ts 互钉)。 */
export const DEEP_GOD_RAYS_SHADOW_FAR_SENTINEL = 1000000000;
/** compute 入口名(消费侧按名取 entry point)。 */
export const DEEP_GOD_RAYS_ENTRY = "marchVolumetricGodRays";
`,
    preamble: `/** 体积光 god rays 半分辨率 ray-march 核(真源 wgsl/volumetricGodRays.wgsl)。 */\nexport const VOLUMETRIC_GOD_RAYS_MARCH_WGSL = /* wgsl */ `,
  },
  {
    source: "displayColor.wgsl",
    module: resolve(packageRoot, "src/webgpu/pbrDisplayColorWgsl.ts"),
    gate: "src/webgpu/outputFamilyWgslChecksum.test.ts",
    constants: "",
    preamble: `export const PBR_DISPLAY_COLOR_WGSL = /* wgsl */ `,
  },
  {
    source: "outputShader.wgsl",
    module: resolve(packageRoot, "src/webgpu/pbrOutputBodyWgsl.ts"),
    gate: "src/webgpu/outputFamilyWgslChecksum.test.ts",
    constants: "",
    preamble: `export const PBR_OUTPUT_BODY_WGSL = /* wgsl */ `,
  },
  {
    source: "directDisplay.wgsl",
    module: resolve(packageRoot, "src/webgpu/pbrDirectDisplayBodyWgsl.ts"),
    gate: "src/webgpu/outputFamilyWgslChecksum.test.ts",
    constants: "",
    preamble: `export const PBR_DIRECT_DISPLAY_BODY_WGSL = /* wgsl */ `,
  },
  {
    source: "cascadedShadowMath.wgsl",
    module: resolve(packageRoot, "src/shadows/cascadedShadowMathWgsl.ts"),
    gate: "src/shadows/cascadedShadowMathWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/frame_bindings.rs",
    constants: "",
    preamble: `export const CASCADED_SHADOW_MATH_WGSL = /* wgsl */ `,
  },
  {
    source: "bloomPrefilter.wgsl",
    module: resolve(packageRoot, "src/postprocess/bloomPrefilterWgsl.ts"),
    gate: "src/postprocess/bloomPrefilterWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/bloom_pass.rs",
    constants: "",
    preamble: `export const BLOOM_PREFILTER_WGSL = /* wgsl */ `,
  },
  {
    source: "fogOpticalDepth.wgsl",
    module: resolve(packageRoot, "src/fog/fogOpticalDepthWgsl.ts"),
    gate: "src/fog/fogOpticalDepthWgslChecksum.test.ts",
    rustHalf: "deep-engine-native/src/output_pass.rs",
    constants: "",
    preamble: `export const FOG_OPTICAL_DEPTH_WGSL = /* wgsl */ `,
  },
  {
    source: "brdfDirectMultiscattering.wgsl",
    module: resolve(packageRoot, "src/lighting/brdfDirectMultiscatteringWgsl.ts"),
    gate: "src/lighting/brdfDirectMultiscatteringWgslChecksum.test.ts",
    constants: "",
    preamble: `export const PBR_BRDF_DIRECT_MULTISCATTERING_WGSL = /* wgsl */ `,
  },
  {
    // AA-M2 后续切片(2026-10-04):时域 AA resolve 核。真源 wgsl/temporalAa.wgsl,
    // 纯 TS 消费(无 Rust 半;TemporalAaPass 直取)。GHOST_GUARD 决策层已接线进历史
    // 融合段:编译期开关 DEEP_TEMPORAL_GHOST_GUARD 默认 0 = 关(基线分支逐字保留,
    // 输出与历史生产逐位一致);决策片段字面常量由 temporalReprojection.ts
    // GHOST_GUARD_REPROJECTION_POLICY 模板化派生,一致性由
    // temporalAaWgslChecksum.test.ts 锁定(镜像 + sha256 + 派生函数逐字互钉)。
    source: "temporalAa.wgsl",
    module: resolve(packageRoot, "src/postprocess/temporalAaWgsl.ts"),
    gate: "src/postprocess/temporalAaWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/** workgroup 尺寸(宿主 dispatch ceil-div 同值;TS 权威,漂移在字节门禁失败)。 */
export const TEMPORAL_AA_WORKGROUP_SIZE = 8;
`,
    preamble: `/** 时域 AA resolve 核(真源 wgsl/temporalAa.wgsl;GHOST_GUARD 决策层编译期开关,默认关 = 历史输出逐位一致)。 */
export const TEMPORAL_AA_WGSL = /* wgsl */ `,
  },
  {
    // AA-M2 后续切片(2026-10-04):F4 时域上采样核。真源 wgsl/temporalUpscale.wgsl,
    // 纯 TS 消费(无 Rust 半;TemporalUpscalePass 直取)。GHOST_GUARD 决策层与
    // temporalAa.wgsl 同名编译期开关、同一派生单源(temporalReprojection.ts),
    // 一致性由 temporalUpscaleWgslChecksum.test.ts 锁定。
    source: "temporalUpscale.wgsl",
    module: resolve(packageRoot, "src/postprocess/temporalUpscaleWgsl.ts"),
    gate: "src/postprocess/temporalUpscaleWgslChecksum.test.ts",
    rustHalf: null,
    constants: `/** workgroup 尺寸(宿主 dispatch ceil-div 同值;TS 权威,漂移在字节门禁失败)。 */
export const TEMPORAL_UPSCALE_WORKGROUP_SIZE = 8;
`,
    preamble: `/** F4 时域上采样核(真源 wgsl/temporalUpscale.wgsl;GHOST_GUARD 决策层编译期开关,默认关 = 历史输出逐位一致)。 */
export const TEMPORAL_UPSCALE_WGSL = /* wgsl */ `,
  },
];

// A selected family lets concurrent slices regenerate their own mirror without rewriting others.
const selectedSource = process.argv.find(argument => argument.startsWith("--source="))?.slice(9);
if (selectedSource && !SHARED_WGSL.some(entry => entry.source === selectedSource)) throw new Error(`Unknown WGSL family: ${selectedSource}`);
for (const entry of SHARED_WGSL.filter(entry => !selectedSource || entry.source === selectedSource)) {
  const sourcePath = resolve(wgslRoot, entry.source);
  const wgsl = await readFile(sourcePath, "utf8");
  const bytes = Buffer.byteLength(wgsl, "utf8");
  const checksum = createHash("sha256").update(wgsl, "utf8").digest("hex");
  const moduleText = `// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/${entry.source}(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
${entry.rustHalf
    ? `// 字节门禁: ${entry.gate}(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: ${entry.rustHalf}(include_str! 引用同一文件,共用同一夹具)。`
    : `// 字节门禁: ${entry.gate}(?raw 读真源 + SHA-256 夹具对拍;无 Rust 半,纯 TS 消费)。`}

${entry.constants}
${entry.preamble}${JSON.stringify(wgsl)};
`;
  await writeFile(entry.module, moduleText, "utf8");
  await writeFile(`${sourcePath}.sha256`, `${checksum} ${bytes}\n`, "utf8");
  console.log(`synced wgsl/${entry.source} -> ${entry.module} (${bytes} bytes, sha256=${checksum})`);
}
