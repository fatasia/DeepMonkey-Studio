// A2 WGSL SDF 碰撞 profile 查询核(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
//
// 职责:对每条查询点逐 lane 输出 SDF 采样碰撞证据 —— trilinear 有符号距离 +
// 中心差分梯度(表面法线估计)+ 域内/域外状态。本核只做查询,不改写任何刚体
// 状态;Rapier 仍是真值来源,本核的误差边界由 sdfCollisionProfile 合同逐字段
// fail-closed 守护(对拍见 deep-engine-native/tests/sdf_collision_profile_truth.rs)。
//
// 确定性合同(并行归约定序):
// - 每 lane 输出只由本 lane 输入决定,无跨 lane 通信、无 workgroup 共享内存、
//   无原子 —— 没有归约就无须归约定序,同输入同 dispatch 逐位回放;
// - 浮点逐运算 IEEE-754 f32;真机 GPU 若做 FMA 融合,与 CPU 镜像的差异走
//   误差预算(与 T18 A3 布料先例同口径:真机探针按容差对拍),CPU 镜像与
//   Rust 镜像之间按逐位对拍(fround/f32 双舍入免疫)。
//
// fail-closed 语义:域外查询(含浮点越界)绝不静默返回「无碰撞」—— distance
// 置为 quiet NaN(0x7fc00000)、status = OUT_OF_DOMAIN,宿主必须拒绝整个批次。
// field 永不含 NaN(buildSdfGrid 已拒绝非有限值),NaN ⇔ 域外,双向可判。

struct QueryParams {
  origin: vec3f,
  cellSize: f32,
  dimensions: vec3u,
  count: u32,
  /** 穿透判据:distance < -contactSkin 记为 penetrating;≥0 为保守收缩。 */
  contactSkin: f32,
};

@group(0) @binding(0) var<uniform> params: QueryParams;
@group(0) @binding(1) var<storage, read> field: array<f32>;
// 查询点,xyz 有效、w 恒 0(对齐 vec4 步长,宿主打包侧互钉)。
@group(0) @binding(2) var<storage, read> queries: array<vec4f>;
// 每 lane 输出:xyz = 梯度(世界单位,中心差分),w = trilinear 有符号距离;
// 域外 lane:w = quiet NaN、xyz = 0。
@group(0) @binding(3) var<storage, read_write> results: array<vec4f>;
// 0 = 域内;1 = 域外(fail-closed,宿主见到任何非 0 即整批拒绝)。
@group(0) @binding(4) var<storage, read_write> statuses: array<u32>;

/** 边界钳制取值:与 sdfGrid.sampleSdfGrid 的 at() 同构,域边一圈常值外推。
 * i32 钳制(u32 减法在 x=0 会回绕到远侧,故梯度 stencil 全走 i32);
 * 索引积 i32 全程(clamp 后非负,上界 < 2³¹),末端一次转 u32。 */
fn at(x: i32, y: i32, z: i32) -> f32 {
  let d = vec3i(params.dimensions);
  let cx = clamp(x, 0, d.x - 1);
  let cy = clamp(y, 0, d.y - 1);
  let cz = clamp(z, 0, d.z - 1);
  return field[u32((cz * d.y + cy) * d.x + cx)];
}

/** trilinear 内插,运算序与 CPU/Rust 镜像逐运算同构:
 * x 向 4 条 → y 向 2 条 → z 向 1 条,统一 lerp2 = a + (b−a)·t。 */
fn trilinear(l: vec3u, f: vec3f) -> f32 {
  let lx = i32(l.x); let ly = i32(l.y); let lz = i32(l.z);
  let d000 = at(lx, ly, lz);
  let d100 = at(lx + 1, ly, lz);
  let d010 = at(lx, ly + 1, lz);
  let d110 = at(lx + 1, ly + 1, lz);
  let d001 = at(lx, ly, lz + 1);
  let d101 = at(lx + 1, ly, lz + 1);
  let d011 = at(lx, ly + 1, lz + 1);
  let d111 = at(lx + 1, ly + 1, lz + 1);
  let x0 = d000 + (d100 - d000) * f.x;
  let x1 = d010 + (d110 - d010) * f.x;
  let x2 = d001 + (d101 - d001) * f.x;
  let x3 = d011 + (d111 - d011) * f.x;
  let y0 = x0 + (x1 - x0) * f.y;
  let y1 = x2 + (x3 - x2) * f.y;
  return y0 + (y1 - y0) * f.z;
}

@compute @workgroup_size(64)
fn queryCollisions(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.count) { return; }
  let p = queries[gid.x].xyz;
  let q = (p - params.origin) / params.cellSize;
  let maxQ = vec3f(params.dimensions - vec3u(1u));
  if (any(q < vec3f(0.0)) || any(q > maxQ)) {
    results[gid.x] = vec4f(0.0, 0.0, 0.0, bitcast<f32>(0x7fc00000u));
    statuses[gid.x] = 1u;
    return;
  }
  let l = vec3u(floor(q));
  let f = q - vec3f(l);
  let lx = i32(l.x); let ly = i32(l.y); let lz = i32(l.z);
  let distance = trilinear(l, f);
  // 中心差分梯度,固定 stencil 序 x→y→z;域边一圈经 at() 钳制退化为单侧差分。
  let h = params.cellSize;
  let gradient = vec3f(
    (at(lx + 1, ly, lz) - at(lx - 1, ly, lz)) / (2.0 * h),
    (at(lx, ly + 1, lz) - at(lx, ly - 1, lz)) / (2.0 * h),
    (at(lx, ly, lz + 1) - at(lx, ly, lz - 1)) / (2.0 * h),
  );
  results[gid.x] = vec4f(gradient, distance);
  statuses[gid.x] = 0u;
}
