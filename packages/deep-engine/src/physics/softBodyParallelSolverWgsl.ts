/**
 * F6/T18 软体 GPU 并行核·第二刀:多 workgroup 并行 WGSL(单源)。
 *
 * 与串行核(softBodyGpuWgsl.ts,单 workgroup 全粒子串行验证核)的分工:
 * 串行核是确定性合同参照;本核把 per-particle/per-edge/per-tet 循环体拆为
 * 独立 invocation,色批序由 TS 侧着色(edge=colorClothConstraints,
 * volume=colorSoftBodyVolumes)经 range uniform 驱动——同色批内无共享粒子,
 * storage 并发写安全。数值口径与串行核逐句对齐(同公式同序,f32;FMA 差异
 * 与布料 A3 同族,由镜像容差承担,不承诺与串行核逐位)。
 *
 * ABI:particles/edges/tets 与串行核同布局;params 96B——头 48B 同旧合同
 * (u32×4 = particleCount/edgeCount/tetCount/substeps;f32 dt/complianceDistance/
 * complianceVolume/damping;gravity vec3 + pad),风 48B 尾与 pack 层
 * packSoftBodyGpuParams 互钉(windEnabled u32@48、windSeed@52、baseSpeed@56、
 * gustFreq@60、spatialScale@64、tickSeconds@68、pad@72..80、windDirection vec4f@80..96);
 * 每色批一个 16B range uniform [start, end, 0, 0](edge 色批与 volume 色批各自一组,
 * 按入口消费)。
 * F6/T18 障碍刀:Obstacle struct 与布料核(clothSolver.wgsl)同 ABI(5×vec4f,80B,
 * 判别式 halfExtents.w=radius);绑定 6=obstacles(storage read)/7=obstacleRange
 * (uniform vec4u=[count,0,0,0])——避开 0..5 既有槽位;projectObstaclesSoftBody
 * 静态使用集={0,3,6,7},auto 布局下宿主只绑静态使用槽(布料教训:绑非静态槽
 * =Invalid BindGroup,Submit 静默丢弃)。
 */
export const SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE = 64;

export const SOFT_BODY_PARALLEL_ENTRY_INTEGRATE = "integrateParticles";
export const SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES = "projectEdgesColor";
export const SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES = "projectVolumesColor";
export const SOFT_BODY_PARALLEL_ENTRY_FINALIZE = "finalizeParticles";
export const SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES = "projectObstaclesSoftBody";

export const SOFT_BODY_PARALLEL_SOLVER_WGSL = /* wgsl */ `
struct SoftBodyParticle { position: vec4f, velocity: vec4f, previous: vec4f }
struct SoftBodyEdge { a: u32, b: u32, restLength: f32, _p0: u32 }
struct SoftBodyTet { i0: u32, i1: u32, i2: u32, i3: u32, restVolume: f32, _p0: u32, _p1: u32, _p2: u32 }
struct Params {
  particleCount: u32, edgeCount: u32, tetCount: u32, substeps: u32,
  dtSeconds: f32, complianceDistance: f32, complianceVolume: f32, damping: f32,
  gravity: vec4f,
  // F6/T18 风场刀(96B 尾,与 packSoftBodyGpuParams 逐槽互钉;布料 Params ABI 同族):
  // windEnabled u32@48、windSeed u32@52(salt 混在 pack 端)、标量 f32×4@56..72、
  // pad@72..80、windDirection vec4f@80..96(w 槽 0)。windEnabled=0 时 integrate
  // 不触风路径(逐位退化,与布料同合同)。
  windEnabled: u32, windSeed: u32, windBaseSpeed: f32, windGustFrequency: f32,
  windSpatialScale: f32, windTickSeconds: f32, _windPad0: u32, _windPad1: u32,
  windDirection: vec4f,
}
// 静态障碍(与布料核同 ABI,pack 端 softBodyGpuWgsl.packSoftBodyGpuObstacles 逐槽同源):
// center.w=radius;rotation 9 floats 从槽 4 连续打包、跨 vec4 边界——按 vec4 视图
// row0=(R00,R01,R02,R10) row1=(R11,R12,R20,R21) row2=(R22,pad,pad,pad)。
// 真源合同:R10=row0.w,R11=row1.x,R12=row1.y,R20=row1.z,R21=row1.w,R22=row2.x。
// 布局教训(r4 真机破案):按"3×vec4 行矩阵"直觉消费会把 R11/R22 当 R10/R20,
// identity/球场景静默无害、旋转 cuboid 全错——跨界取数逐槽钉死,checksum 字面锚。
struct Obstacle {
  center: vec4f,
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  halfExtents: vec4f,
}
@group(0) @binding(0) var<storage, read_write> particles: array<SoftBodyParticle>;
@group(0) @binding(1) var<storage, read> edges: array<SoftBodyEdge>;
@group(0) @binding(2) var<storage, read> tets: array<SoftBodyTet>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<uniform> colorRange: vec4u;
@group(0) @binding(5) var<storage, read_write> kineticPartials: array<f32>;
@group(0) @binding(6) var<storage, read> obstacles: array<Obstacle>;
@group(0) @binding(7) var<uniform> obstacleRange: vec4u;

// F6/T18 风场:确定性 value noise——与布料单源 wgsl/clothSolver.wgsl 的 windHash/
// windValueNoise 逐字同文(hash 整数链纯 u32 逐位;quintic/lerp 标量 f32 同 op 序),
// 镜像侧单一真源在 clothParallelSolver.mirrorWindNoise(跨族共享,禁复制)。
const WIND_INV_UINT32 = 2.3283064365386963e-10;
fn windHash(xi: i32, zi: i32, seed: u32) -> u32 {
  var h = (u32(xi) * 0x27d4eb2du) ^ (u32(zi) * 0x165667b1u) ^ (seed * 0x9e3779b9u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return h;
}
fn windValueNoise(x: f32, z: f32, seed: u32) -> f32 {
  let xi = floor(x); let zi = floor(z);
  let tx = x - xi; let tz = z - zi;
  let sx = tx * tx * tx * (tx * (tx * 6.0 - 15.0) + 10.0);
  let sz = tz * tz * tz * (tz * (tz * 6.0 - 15.0) + 10.0);
  let v00 = f32(windHash(i32(xi), i32(zi), seed)) * WIND_INV_UINT32;
  let v10 = f32(windHash(i32(xi) + 1, i32(zi), seed)) * WIND_INV_UINT32;
  let v01 = f32(windHash(i32(xi), i32(zi) + 1, seed)) * WIND_INV_UINT32;
  let v11 = f32(windHash(i32(xi) + 1, i32(zi) + 1, seed)) * WIND_INV_UINT32;
  let a = v00 + (v10 - v00) * sx;
  let b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz;
}

fn integrateOne(index: u32, h: f32, dampingScale: f32) {
  var particle = particles[index];
  particle.previous = particle.position;
  if (particle.position.w == 0.0) { particle.velocity = vec4f(0.0); }
  else {
    // 风场刀:加速度 = gravity + windDirection·speed(windEnabled=0 时三标量恒等
    // gravity,后续算式不变——零风路径与旧核逐位同构)。标量展开与布料核同式,
    // 镜像 f32 逐运算同构(f(f(v + f((g+w)·h))·damp))。
    var ax = params.gravity.x; var ay = params.gravity.y; var az = params.gravity.z;
    if (params.windEnabled != 0u) {
      let noise = windValueNoise(params.windTickSeconds * params.windGustFrequency,
        particle.position.y * params.windSpatialScale, params.windSeed);
      let speed = params.windBaseSpeed * (0.5 + noise);
      ax = ax + params.windDirection.x * speed;
      ay = ay + params.windDirection.y * speed;
      az = az + params.windDirection.z * speed;
    }
    let vx = (particle.velocity.x + ax * h) * dampingScale;
    let vy = (particle.velocity.y + ay * h) * dampingScale;
    let vz = (particle.velocity.z + az * h) * dampingScale;
    particle.velocity = vec4f(vx, vy, vz, particle.velocity.w);
    particle.position = vec4f(particle.position.xyz + vec3f(vx, vy, vz) * h, particle.position.w);
  }
  particles[index] = particle;
}

fn finalizeOne(index: u32, invH: f32) {
  var particle = particles[index];
  if (particle.position.w == 0.0) { particle.velocity = vec4f(0.0); }
  else { particle.velocity = vec4f((particle.position.xyz - particle.previous.xyz) * invH, particle.velocity.w); }
  particles[index] = particle;
}

@compute @workgroup_size(64)
fn integrateParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.particleCount) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  integrateOne(id.x, h, 1.0 - params.damping * h);
}

// 边距离投影(每边一 invocation;colorRange=[start,end) 圈定本色批)。
@compute @workgroup_size(64)
fn projectEdgesColor(@builtin(global_invocation_id) id: vec3u) {
  let edgeIndex = colorRange.x + id.x;
  if (id.x >= colorRange.y - colorRange.x) { return; }
  let edge = edges[edgeIndex];
  var a = particles[edge.a]; var b = particles[edge.b];
  let delta = a.position.xyz - b.position.xyz;
  let length = sqrt(dot(delta, delta));
  let denominator = a.position.w + b.position.w;
  if (length > 0.0 && denominator > 0.0) {
    let h = params.dtSeconds / max(f32(params.substeps), 1.0);
    let alphaEdge = params.complianceDistance / (h * h);
    let correction = (edge.restLength - length) / (denominator + alphaEdge);
    let direction = delta / length;
    a.position = vec4f(a.position.xyz + direction * correction * a.position.w, a.position.w);
    b.position = vec4f(b.position.xyz - direction * correction * b.position.w, b.position.w);
    particles[edge.a] = a; particles[edge.b] = b;
  }
}

// 体积投影(每 tet 一 invocation;四角 XPBD 梯度,公式与串行核逐句同源)。
@compute @workgroup_size(64)
fn projectVolumesColor(@builtin(global_invocation_id) id: vec3u) {
  let tetIndex = colorRange.x + id.x;
  if (id.x >= colorRange.y - colorRange.x) { return; }
  let tet = tets[tetIndex];
  let ids = array<u32, 4>(tet.i0, tet.i1, tet.i2, tet.i3);
  var gradients: array<vec3f, 4>;
  let p0 = particles[tet.i0].position.xyz; let p1 = particles[tet.i1].position.xyz;
  let p2 = particles[tet.i2].position.xyz; let p3 = particles[tet.i3].position.xyz;
  gradients[0] = cross(p1 - p3, p2 - p3) / 6.0;
  gradients[1] = cross(p2 - p3, p0 - p3) / 6.0;
  gradients[2] = cross(p0 - p3, p1 - p3) / 6.0;
  gradients[3] = -(gradients[0] + gradients[1] + gradients[2]);
  var denominator = 0.0;
  for (var corner = 0u; corner < 4u; corner += 1u) {
    denominator += particles[ids[corner]].position.w * dot(gradients[corner], gradients[corner]);
  }
  if (denominator <= 0.0) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  let alphaVolume = params.complianceVolume / (h * h);
  let volume = dot(p0 - p3, cross(p1 - p3, p2 - p3)) / 6.0;
  let correction = (tet.restVolume - volume) / (denominator + alphaVolume);
  for (var corner = 0u; corner < 4u; corner += 1u) {
    var particle = particles[ids[corner]];
    particle.position = vec4f(particle.position.xyz + particle.position.w * correction * gradients[corner], particle.position.w);
    particles[ids[corner]] = particle;
  }
}

// 速度回算 + 动能部分和(每 invocation 写自身粒子的 v²/2 部分和槽位由宿主归约;
// 第一刀只做速度回算,kinetic 槽保留布局供第三刀镜像对齐)。
@compute @workgroup_size(64)
fn finalizeParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.particleCount) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  finalizeOne(id.x, 1.0 / h);
}

// pass B0:静态障碍接触投影(每粒子一 invocation;障碍固定序单遍循环;锚点跳过)。
// 与 f64 黄金 softBodyStaticCollision.ts 逐式同构:toLocal = Rᵀ·d(行主序旋转的转置),
// world = center + R·local;判定轴推出取 ±half(lx=0 归 +half,同黄金 (x<0?-1:1))。
// 与布料核 projectObstacles 的刻意差异:布料 toLocal 用 R·d(对 identity/sphere 等价,
// 旋转 cuboid 与黄金转置不一致——已登记布料线后续项);本核以软体黄金为准。
// 边界:单遍循环(布料先例同边界),多障碍重叠的 4-sweep 收敛不在本刀。
@compute @workgroup_size(64)
fn projectObstaclesSoftBody(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.particleCount) { return; }
  var particle = particles[index];
  if (particle.position.w == 0.0) { return; }
  var px = particle.position.x; var py = particle.position.y; var pz = particle.position.z;
  for (var o = 0u; o < obstacleRange.x; o += 1u) {
    let obstacle = obstacles[o];
    let dx = px - obstacle.center.x; let dy = py - obstacle.center.y; let dz = pz - obstacle.center.z;
    // 判别式合同:halfExtents.w = radius(sphere,>0)或 0(cuboid)——pack 端
    // (softBodyGpuWgsl.ts packSoftBodyGpuObstacles)槽 19 写入,两侧同源。
    if (obstacle.halfExtents.w > 0.0) {
      // sphere:归一化推到半径面(与 f64 黄金 sphere 分支同式)。
      let dist = sqrt(dx * dx + dy * dy + dz * dz);
      let radius = obstacle.center.w;
      if (dist < radius && dist > 0.0) {
        px = obstacle.center.x + dx / dist * radius;
        py = obstacle.center.y + dy / dist * radius;
        pz = obstacle.center.z + dz / dist * radius;
      } else if (dist == 0.0) {
        // 中心退化:沿世界 x 轴像 R·(radius,0,0) 推出 = (R00,R10,R20)·radius
        // =(row0.x,row0.w,row1.z)·radius(跨界布局合同,见 struct 注释)。
        px = obstacle.center.x + obstacle.row0.x * radius;
        py = obstacle.center.y + obstacle.row0.w * radius;
        pz = obstacle.center.z + obstacle.row1.z * radius;
      }
    } else {
      // cuboid OBB:toLocal = Rᵀ·d —— x=(R00,R10,R20)·d=row0.x,row0.w,row1.z;
      // y=(R01,R11,R21)·d=row0.y,row1.x,row1.w;z=(R02,R12,R22)·d=row0.z,row1.y,row2.x。
      // (跨界布局合同;按 vec4 行直觉消费=布局错位,r4 真机破案,见 struct 注释。)
      let lx = obstacle.row0.x * dx + obstacle.row0.w * dy + obstacle.row1.z * dz;
      let ly = obstacle.row0.y * dx + obstacle.row1.x * dy + obstacle.row1.w * dz;
      let lz = obstacle.row0.z * dx + obstacle.row1.y * dy + obstacle.row2.x * dz;
      let hx = obstacle.halfExtents.x; let hy = obstacle.halfExtents.y; let hz = obstacle.halfExtents.z;
      let inside = (abs(lx) < hx) && (abs(ly) < hy) && (abs(lz) < hz);
      if (inside) {
        let penX = hx - abs(lx); let penY = hy - abs(ly); let penZ = hz - abs(lz);
        var localX = lx; var localY = ly; var localZ = lz;
        if (penX <= penY && penX <= penZ) { localX = select(-hx, hx, lx >= 0.0); }
        else if (penY <= penZ) { localY = select(-hy, hy, ly >= 0.0); }
        else { localZ = select(-hz, hz, lz >= 0.0); }
        // 局部→世界 world = center + R·local:
        // x=R00·lx+R01·ly+R02·lz=row0.xyz·local;y=R10·lx+R11·ly+R12·lz=row0.w,row1.x,row1.y;
        // z=R20·lx+R21·ly+R22·lz=row1.z,row1.w,row2.x。
        px = obstacle.center.x + obstacle.row0.x * localX + obstacle.row0.y * localY + obstacle.row0.z * localZ;
        py = obstacle.center.y + obstacle.row0.w * localX + obstacle.row1.x * localY + obstacle.row1.y * localZ;
        pz = obstacle.center.z + obstacle.row1.z * localX + obstacle.row1.w * localY + obstacle.row2.x * localZ;
      }
    }
  }
  particle.position = vec4f(px, py, pz, particle.position.w);
  particles[index] = particle;
}
`;
