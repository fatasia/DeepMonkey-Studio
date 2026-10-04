// Brief-GI M3 SDF 场景烘焙 compute 核(2026-10-05):每 lane = 一个场景格 cell,
// 对世界系三角形集合求点到三角形精确距离的 min + +X 射线奇偶定号,写出场景级
// 距离场(f32/cell)。CPU 权威 = gi/sdfSceneBakeGrid.ts + physics/sdfGrid.ts
// (buildSdfGrid 的 triangleDistance/rayX 同式;GPU f32 与 CPU f64 中间量的差异走
// 抽样容差对拍,如实记录)。CPU 增量烘焙保留为回退与验收参考。
//
// == 与 CPU 合同的逐条对应 ==
// - 距离:triangleDistance 解析式逐式同构(顶点/边/面三分支;WGSL f32);
// - 定号:rayX 的 Möller–Trumbore 同式(±1e-8 容差、t>1e-8);CPU 对交点排序后按
//   1e-6·cellSize 容差去重计数,GPU 核无排序设备 —— 采用逐三角形直接计数(交点
//   几乎重合的退化射线[共棱/共顶]计数可能不同,差异 cell 数在验收对拍中如实报告);
// - 域裁剪:每三角形携带其所属实例的烘焙域(origin + dims,aabb 域 = AABB ±1 cell,
//   scene 域 = 全场景;与 bakeInstanceGrid 同式)。cell 世界点按 round 舍入界判域
//   (与 composeInstance 的 round 查找一致),域外实例不贡献距离也不贡献交点;
// - 合成:field = sign × min(nearest, exteriorDistance)。与 CPU 的
//   「初始 exteriorDistance + min 合成 + 负值钳 −exteriorDistance」逐值恒等
//   (min(ext, min(各实例距离)) ≡ min(ext, 全体距离);max(d,−ext) = −min(d, ext))。
//
// == 确定性 ==
// 每 lane 独立(无跨 lane 通信/原子);三角形固定序遍历(输入序即上传序),同输入
// 逐位回放;场永不含 NaN(nearest 初值 = exteriorDistance,循环恒有界)。

struct BakeParams {
  /** 场景格分辨率(x,y,z)。 */
  dimensions: vec3u,
  /** 世界系三角形数(上传序)。 */
  triangleCount: u32,
  /** 体素边长(米)。 */
  cellSize: f32,
  /** 场景格原点(xyz)。 */
  origin: vec3f,
  /** 有界外推圈外的场值(米;合成钳制界)。 */
  exteriorDistance: f32,
  /** 总 cell 数(dx×dy×dz;lane 越界早退线)。 */
  cellCount: u32,
};

@group(0) @binding(0) var<uniform> params: BakeParams;
// 世界系三角形表(每三角形 5 vec4):
//   [0..2] = 顶点 a/b/c(xyz,w=0);
//   [3] = (域 origin.xyz, 域 dimX);[4] = (域 dimY, 域 dimZ, 0, 0)。
@group(0) @binding(1) var<storage, read> triangles: array<vec4f>;
// 场景距离场(f32/cell,下标 = (z×dy + y)×dx + x)。
@group(0) @binding(2) var<storage, read_write> field: array<f32>;

fn triangleDistance(p: vec3f, a: vec3f, b: vec3f, c: vec3f) -> f32 {
  let ab = b - a;
  let ac = c - a;
  let ap = p - a;
  let d1 = dot(ab, ap);
  let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) { return length(ap); }
  let bp = p - b;
  let d3 = dot(ab, bp);
  let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) { return length(bp); }
  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    return length(p - (a + ab * (d1 / (d1 - d3))));
  }
  let cp = p - c;
  let d5 = dot(ab, cp);
  let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) { return length(cp); }
  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    return length(p - (a + ac * (d2 / (d2 - d6))));
  }
  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0) {
    let bc = c - b;
    let t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return length(p - (b + bc * t));
  }
  let normal = cross(ab, ac);
  return abs(dot(ap, normal)) / length(normal);
}

// +X 射线奇偶定号(Möller–Trumbore,与 CPU rayX 同式;有交 = true)。
fn rayXHits(p: vec3f, a: vec3f, b: vec3f, c: vec3f) -> bool {
  let e1 = b - a;
  let e2 = c - a;
  let h = vec3f(0.0, -e2.z, e2.y);
  let det = dot(e1, h);
  if (abs(det) < 1e-10) { return false; }
  let f = 1.0 / det;
  let s = p - a;
  let u = f * dot(s, h);
  if (u < -1e-8 || u > 1.0 + 1e-8) { return false; }
  let q = vec3f(s.y * e1.z - s.z * e1.y, s.z * e1.x - s.x * e1.z, s.x * e1.y - s.y * e1.x);
  let v = f * q.x;
  if (v < -1e-8 || u + v > 1.0 + 1e-8) { return false; }
  let t = f * dot(e2, q);
  return t > 1e-8;
}

@compute @workgroup_size(64)
fn sdfBakeSceneGridMain(@builtin(global_invocation_id) gid: vec3u) {
  let linear = gid.x;
  if (linear >= params.cellCount) { return; }
  let dx = params.dimensions.x;
  let dy = params.dimensions.y;
  let cell = vec3u(linear % dx, (linear / dx) % dy, linear / (dx * dy));
  let p = params.origin + vec3f(cell) * params.cellSize;
  var nearest = params.exteriorDistance;
  var crossings = 0u;
  for (var index = 0u; index < params.triangleCount; index = index + 1u) {
    let base = index * 5u;
    let a = triangles[base].xyz;
    let b = triangles[base + 1u].xyz;
    let c = triangles[base + 2u].xyz;
    // 实例烘焙域(round 舍入界,与 CPU composeInstance 的 round 查找一致):
    // 域内 = round((p − origin)/cs) ∈ [0, dims−1];dims 以 f32 通道上传(≤128 精确),
    // 显式 u32() 转换(f32 → vec3u 无隐式构造,Dawn 真机拒编译)。
    let domainOrigin = triangles[base + 3u].xyz;
    let domainDims = vec3u(u32(triangles[base + 3u].w), u32(triangles[base + 4u].x),
      u32(triangles[base + 4u].y));
    let local = round((p - domainOrigin) / params.cellSize);
    if (any(local < vec3f(0.0)) || any(local > vec3f(domainDims) - vec3f(1.0))) { continue; }
    nearest = min(nearest, triangleDistance(p, a, b, c));
    if (rayXHits(p, a, b, c)) { crossings = crossings + 1u; }
  }
  let sign = select(1.0, -1.0, crossings % 2u == 1u);
  field[linear] = sign * nearest;
}
