// Brief-GI M1 天光遮蔽核:探针方向 × 场景 SDF 圆锥追踪(WGSL 单源,TS 半为生成镜像)。
//
// 职责:每 lane 处理一个 (探针位置 × 天光方向) 对,沿方向固定 8..16 步前进,逐步
// trilinear 采样场景级 SDF(gi/sdfSceneBake.ts 烘焙的静态合成场),按软阴影口径
// vis = min_i clamp(sdf(t_i) / (coneTan·t_i), 0, 1) 输出该方向的天光可见度 ∈[0,1]。
// 16/32 方向 Fibonacci 方向表由宿主按 probeOcclusionDirection(CPU 权威)打包,
// 可见性向量随后投影为 L1 SH(gi/probeSkyVisibilitySh.ts)。
//
// GI-FIN(2026-10-05)命中距离统计:同一步进循环里,首个「圆锥被几何侵入」的步
// (contribution < 1,即 sdf(t_i) < coneTan·t_i)记为本方向的命中距离 t_i;全程无
// 侵入 = miss,记哨兵 −1。逐 lane 输出到 hitDistances(probeCount × directionCount,
// 下标与 visibilities 同式),由探针更新核(sdfGiProbeUpdate.wgsl)按探针归约成
// (meanDistance, distanceVariance) 回写记录 vec4[1].xy —— 采样链 Chebyshev 可见性
// 的真实几何统计(字段本为此预留;语义对齐 probeOcclusionRayExtension:mean = 命中
// 距离均值、var = 命中距离总体方差、全 miss 由更新核取 maxDistance)。注意这是
// 圆锥软阴影口径的步进量化命中(步心),不是精确最近命中;variance 覆盖「不同方向
// 遮蔽距离的离散度」,正是采样端判遮挡所需的量。
//
// 确定性合同(与 sdfCollisionQuery.wgsl 同族):
// - 每 lane 输出只由本 lane 输入决定:无跨 lane 通信、无 workgroup 内存、无原子,
//   同输入同 dispatch 逐位回放;步进循环固定步数(无 early-break),分支与时序无关。
// - 浮点逐运算 IEEE-754 f32;CPU 镜像(gi/sdfSkyVisibility.ts)按同序 fround;
//   真机 GPU 若 FMA 融合,差异走容差对拍(A3 布料先例口径)。
//
// 域外语义(与碰撞查询的 fail-closed **刻意不同**,见源注释):天光可见性是光照量
// 不是安全量——探针在场景 SDF 域外时视作「直达天空」(vis=1)而非 NaN;烘焙网格
// 之外的世界本就是开放天空,吞掉这一档会造出假影。场内永不含 NaN(烘焙合同),
// 因此本核不产出也不传播 NaN。

struct SkyTraceParams {
  origin: vec3f,
  cellSize: f32,
  dimensions: vec3u,
  steps: u32,
  /** 圆锥半角正切(>0);limit = max(coneTan·t, 1e-6)。 */
  coneTan: f32,
  maxDistance: f32,
  directionCount: u32,
  probeCount: u32,
};

@group(0) @binding(0) var<uniform> params: SkyTraceParams;
@group(0) @binding(1) var<storage, read> field: array<f32>;
// 探针位置,xyz 有效、w 恒 0(vec4 步长,宿主打包侧互钉)。
@group(0) @binding(2) var<storage, read> probePositions: array<vec4f>;
// 天光方向表(CPU 权威 Fibonacci 集),xyz 有效、w 恒 0。
@group(0) @binding(3) var<storage, read> directions: array<vec4f>;
// 每 lane 输出:天光可见度 ∈[0,1](1 = 全程直达天空)。
@group(0) @binding(4) var<storage, read_write> visibilities: array<f32>;
// 每 lane 输出:首个圆锥侵入步的步心距离(米);miss = −1(与 visibilities 同下标)。
@group(0) @binding(5) var<storage, read_write> hitDistances: array<f32>;

/** 边界钳制取值(与 sdfCollisionQuery.wgsl 的 at() 同构;域边一圈常值外推)。 */
fn at(x: i32, y: i32, z: i32) -> f32 {
  let d = vec3i(params.dimensions);
  let cx = clamp(x, 0, d.x - 1);
  let cy = clamp(y, 0, d.y - 1);
  let cz = clamp(z, 0, d.z - 1);
  return field[u32((cz * d.y + cy) * d.x + cx)];
}

/** trilinear 内插,运算序与 sdfCollisionQuery.wgsl 逐式一致(x4 → y2 → z1)。 */
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

fn sampleField(p: vec3f) -> f32 {
  let q = (p - params.origin) / params.cellSize;
  let maxQ = vec3f(params.dimensions - vec3u(1u));
  if (any(q < vec3f(0.0)) || any(q > maxQ)) {
    // 域外 = 开放空间(距离无界,可见性贡献恒 1;与烘焙域的外推圈语义一致,
    // 绝不把边界环的近零距离泄漏到域外 —— 否则天空方向全部被假遮蔽)。
    return 1000000.0;
  }
  let clamped = clamp(q, vec3f(0.0), maxQ);
  let l = vec3u(floor(clamped));
  return trilinear(l, clamped - vec3f(l));
}

@compute @workgroup_size(64)
fn traceSkyVisibility(@builtin(global_invocation_id) gid: vec3u) {
  let lane = gid.x;
  if (lane >= params.probeCount * params.directionCount) { return; }
  let probe = probePositions[lane / params.directionCount].xyz;
  let direction = normalize(directions[lane % params.directionCount].xyz);
  let q = (probe - params.origin) / params.cellSize;
  let maxQ = vec3f(params.dimensions - vec3u(1u));
  if (any(q < vec3f(0.0)) || any(q > maxQ)) {
    // 域外 = 开放天空(fail-open 光照语义,见头部);非安全查询,不产 NaN。
    visibilities[lane] = 1.0;
    hitDistances[lane] = -1.0;
    return;
  }
  var visibility = 1.0;
  // 命中距离:首个 contribution < 1 的步心(全程无侵入保持哨兵 −1 = miss)。
  var hitDistance = -1.0;
  let stepLength = params.maxDistance / f32(params.steps);
  for (var step = 0u; step < params.steps; step = step + 1u) {
    let t = (f32(step) + 0.5) * stepLength;
    let distance = sampleField(probe + direction * t);
    let limit = max(params.coneTan * t, 0.000001);
    let contribution = clamp(distance / limit, 0.0, 1.0);
    if (hitDistance < 0.0 && contribution < 1.0) { hitDistance = t; }
    visibility = min(visibility, contribution);
  }
  visibilities[lane] = visibility;
  hitDistances[lane] = hitDistance;
}
