// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/sdfCollisionQuery.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/physics/sdfCollisionQueryWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍);
//          Rust 半: deep-engine-native/tests/sdf_collision_profile_truth.rs(include_str! 引用同一文件,共用同一夹具)。

/**
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

/** SDF 碰撞 profile 查询核:trilinear 距离 + 中心差分梯度 + 域外 fail-closed(真源 wgsl/sdfCollisionQuery.wgsl)。 */
export const DEEP_SDF_COLLISION_QUERY_WGSL = /* wgsl */ "// A2 WGSL SDF 碰撞 profile 查询核(WGSL 单源,TS 与 Rust 双端共享同一份文件)。\n//\n// 职责:对每条查询点逐 lane 输出 SDF 采样碰撞证据 —— trilinear 有符号距离 +\n// 中心差分梯度(表面法线估计)+ 域内/域外状态。本核只做查询,不改写任何刚体\n// 状态;Rapier 仍是真值来源,本核的误差边界由 sdfCollisionProfile 合同逐字段\n// fail-closed 守护(对拍见 deep-engine-native/tests/sdf_collision_profile_truth.rs)。\n//\n// 确定性合同(并行归约定序):\n// - 每 lane 输出只由本 lane 输入决定,无跨 lane 通信、无 workgroup 共享内存、\n//   无原子 —— 没有归约就无须归约定序,同输入同 dispatch 逐位回放;\n// - 浮点逐运算 IEEE-754 f32;真机 GPU 若做 FMA 融合,与 CPU 镜像的差异走\n//   误差预算(与 T18 A3 布料先例同口径:真机探针按容差对拍),CPU 镜像与\n//   Rust 镜像之间按逐位对拍(fround/f32 双舍入免疫)。\n//\n// fail-closed 语义:域外查询(含浮点越界)绝不静默返回「无碰撞」—— distance\n// 置为 quiet NaN(0x7fc00000)、status = OUT_OF_DOMAIN,宿主必须拒绝整个批次。\n// field 永不含 NaN(buildSdfGrid 已拒绝非有限值),NaN ⇔ 域外,双向可判。\n\nstruct QueryParams {\n  origin: vec3f,\n  cellSize: f32,\n  dimensions: vec3u,\n  count: u32,\n  /** 穿透判据:distance < -contactSkin 记为 penetrating;≥0 为保守收缩。 */\n  contactSkin: f32,\n};\n\n@group(0) @binding(0) var<uniform> params: QueryParams;\n@group(0) @binding(1) var<storage, read> field: array<f32>;\n// 查询点,xyz 有效、w 恒 0(对齐 vec4 步长,宿主打包侧互钉)。\n@group(0) @binding(2) var<storage, read> queries: array<vec4f>;\n// 每 lane 输出:xyz = 梯度(世界单位,中心差分),w = trilinear 有符号距离;\n// 域外 lane:w = quiet NaN、xyz = 0。\n@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;\n// 0 = 域内;1 = 域外(fail-closed,宿主见到任何非 0 即整批拒绝)。\n@group(0) @binding(4) var<storage, read_write> statuses: array<u32>;\n\n/** 边界钳制取值:与 sdfGrid.sampleSdfGrid 的 at() 同构,域边一圈常值外推。\n * i32 钳制(u32 减法在 x=0 会回绕到远侧,故梯度 stencil 全走 i32);\n * 索引积 i32 全程(clamp 后非负,上界 < 2³¹),末端一次转 u32。 */\nfn at(x: i32, y: i32, z: i32) -> f32 {\n  let d = vec3i(params.dimensions);\n  let cx = clamp(x, 0, d.x - 1);\n  let cy = clamp(y, 0, d.y - 1);\n  let cz = clamp(z, 0, d.z - 1);\n  return field[u32((cz * d.y + cy) * d.x + cx)];\n}\n\n/** trilinear 内插,运算序与 CPU/Rust 镜像逐运算同构:\n * x 向 4 条 → y 向 2 条 → z 向 1 条,统一 lerp2 = a + (b−a)·t。 */\nfn trilinear(l: vec3u, f: vec3f) -> f32 {\n  let lx = i32(l.x); let ly = i32(l.y); let lz = i32(l.z);\n  let d000 = at(lx, ly, lz);\n  let d100 = at(lx + 1, ly, lz);\n  let d010 = at(lx, ly + 1, lz);\n  let d110 = at(lx + 1, ly + 1, lz);\n  let d001 = at(lx, ly, lz + 1);\n  let d101 = at(lx + 1, ly, lz + 1);\n  let d011 = at(lx, ly + 1, lz + 1);\n  let d111 = at(lx + 1, ly + 1, lz + 1);\n  let x0 = d000 + (d100 - d000) * f.x;\n  let x1 = d010 + (d110 - d010) * f.x;\n  let x2 = d001 + (d101 - d001) * f.x;\n  let x3 = d011 + (d111 - d011) * f.x;\n  let y0 = x0 + (x1 - x0) * f.y;\n  let y1 = x2 + (x3 - x2) * f.y;\n  return y0 + (y1 - y0) * f.z;\n}\n\n@compute @workgroup_size(64)\nfn queryCollisions(@builtin(global_invocation_id) gid: vec3u) {\n  if (gid.x >= params.count) { return; }\n  let p = queries[gid.x].xyz;\n  let q = (p - params.origin) / params.cellSize;\n  let maxQ = vec3f(params.dimensions - vec3u(1u));\n  if (any(q < vec3f(0.0)) || any(q > maxQ)) {\n    results[gid.x] = vec4f(0.0, 0.0, 0.0, bitcast<f32>(0x7fc00000u));\n    statuses[gid.x] = 1u;\n    return;\n  }\n  let l = vec3u(floor(q));\n  let f = q - vec3f(l);\n  let lx = i32(l.x); let ly = i32(l.y); let lz = i32(l.z);\n  let distance = trilinear(l, f);\n  // 中心差分梯度,固定 stencil 序 x→y→z;域边一圈经 at() 钳制退化为单侧差分。\n  let h = params.cellSize;\n  let gradient = vec3f(\n    (at(lx + 1, ly, lz) - at(lx - 1, ly, lz)) / (2.0 * h),\n    (at(lx, ly + 1, lz) - at(lx, ly - 1, lz)) / (2.0 * h),\n    (at(lx, ly, lz + 1) - at(lx, ly, lz - 1)) / (2.0 * h),\n  );\n  results[gid.x] = vec4f(gradient, distance);\n  statuses[gid.x] = 0u;\n}\n";
