// T18 A3 并行切片:布料 XPBD 距离约束 GPU compute 核(WGSL 单源真源)。
//
// 确定性合同(与 CPU f32 模拟镜像 src/physics/clothParallelSolver.ts 逐运算同构):
// - 投影路径 = 确定性图着色色序 Gauss-Seidel:约束按色桶连续存放(colorRanges),
//   同色约束两两不共享端点 → 色内并行无写冲突,色间按 dispatch 顺序串行;
//   色序由宿主端贪心着色(clothConstraintColoring.ts,纯整型)唯一决定。
// - 统计路径 = 三级固定归约树:lane 内 pairwise → workgroup 64 lane 共享内存
//   pairwise 树(零填充)→ 每 workgroup 一个独立 slot(单写者,无原子),
//   宿主按固定合并树汇总。所有求和的加法配对在双端逐位一致。
// - 全部算术显式标量化(禁向量化重排空间),f32 IEEE-754 正确舍入,无 FMA 依赖;
//   除 sqrt(IEEE 正确舍入)外无超越函数,无随机源,无时钟。
//
// ABI(宿主常量与 clothParallelSolver.ts 互钉):
// - 粒子 48 B ClothParticle{position+invMass, velocity, previous}(vec4f ×3);
// - 约束 16 B ClothConstraint{a, b, restLength, pad},按色桶排序;
// - 全局参数 48 B ClothParams;每色 stepRange 16 B(rangeStart/rangeEnd);
// - kineticPartials:每 workgroup 1 个 f32 slot(单写者)。
//
// 真值链:clothSolver.ts(f64 黄金,构建序投影)是物理真值;本核是 f32 并行
// 加速/证据路径,与黄金的受控偏差 = f32 量化 + 色桶序投影,量化对照见
// clothParallelSolver.test.ts 的逐步指纹表(容差内,不逐位)。

const DEEP_CLOTH_PARALLEL_WORKGROUP_SIZE: u32 = 64u;

struct ClothParticle {
  position: vec4f,
  velocity: vec4f,
  previous: vec4f,
}
struct ClothConstraint {
  a: u32,
  b: u32,
  restLength: f32,
  _padding: u32,
}
struct ClothParams {
  particleCount: u32,
  constraintCount: u32,
  substeps: u32,
  colorCount: u32,
  dtSeconds: f32,
  compliance: f32,
  damping: f32,
  windEnabled: u32,
  gravity: vec4f,
  windDirection: vec4f,
  windSeed: u32,
  windBaseSpeed: f32,
  windGustFrequency: f32,
  windSpatialScale: f32,
  windTickSeconds: f32,
  obstacleCount: u32,
  _obstaclePad0: u32,
  _obstaclePad1: u32,
}
struct ClothStepRange {
  rangeStart: u32,
  rangeEnd: u32,
  _padding0: u32,
  _padding1: u32,
}
// 静态障碍:行主序旋转(与 softBodyStaticCollision.ts 同构);radius>0=sphere,否则 cuboid。
struct Obstacle {
  center: vec4f,
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  halfExtents: vec4f,
}

@group(0) @binding(0) var<storage, read_write> particles: array<ClothParticle>;
@group(0) @binding(1) var<storage, read> constraints: array<ClothConstraint>;
@group(0) @binding(2) var<uniform> params: ClothParams;
@group(0) @binding(3) var<uniform> stepRange: ClothStepRange;
@group(0) @binding(4) var<storage, read_write> kineticPartials: array<f32>;
@group(0) @binding(5) var<storage, read> obstacles: array<Obstacle>;
@group(0) @binding(6) var<uniform> obstacleRange: vec4u;

var<workgroup> laneKinetics: array<f32, 64>;

// pass A:积分(每粒子独立纯函数;锚点保持原位并清零速度)。
@compute @workgroup_size(64)
fn integrateParticles(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.particleCount) { return; }
  let h = params.dtSeconds / f32(params.substeps);
  let dampingScale = 1.0 - params.damping * h;
  var particle = particles[index];
  // previous 只搬 xyz(w 槽与 CPU 镜像 clothParallelSolver.ts 同约定:不写、保持 0;
  // 整 vec4 赋值会把 invMass 带进 w,污染读回态指纹)。
  particle.previous = vec4f(particle.position.xyz, particle.previous.w);
  if (particle.position.w == 0.0) {
    particle.velocity = vec4f(0.0);
    particles[index] = particle;
    return;
  }
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
  let px = particle.position.x + vx * h;
  let py = particle.position.y + vy * h;
  let pz = particle.position.z + vz * h;
  particle.position = vec4f(px, py, pz, particle.position.w);
  particles[index] = particle;
}

// pass B:单色约束投影(色内端点不相交;色间由 dispatch 序定序)。
@compute @workgroup_size(64)
fn projectConstraintsColor(@builtin(global_invocation_id) id: vec3u) {
  let bucket = stepRange.rangeStart + id.x;
  if (id.x >= (stepRange.rangeEnd - stepRange.rangeStart)) { return; }
  let h = params.dtSeconds / f32(params.substeps);
  let alphaTilde = params.compliance / (h * h);
  let constraint = constraints[bucket];
  let aIndex = constraint.a;
  let bIndex = constraint.b;
  let aParticle = particles[aIndex];
  let bParticle = particles[bIndex];
  let weightA = aParticle.position.w;
  let weightB = bParticle.position.w;
  let denom = weightA + weightB;
  if (denom == 0.0) { return; }
  let dx = aParticle.position.x - bParticle.position.x;
  let dy = aParticle.position.y - bParticle.position.y;
  let dz = aParticle.position.z - bParticle.position.z;
  let lenSq = (dx * dx + dy * dy) + dz * dz;
  let len = sqrt(lenSq);
  if (len == 0.0) { return; }
  let numerator = constraint.restLength - len;
  let denominator = denom + alphaTilde;
  let correction = numerator / denominator;
  if (correction == 0.0) { return; }
  let invLen = 1.0 / len;
  let nx = dx * invLen;
  let ny = dy * invLen;
  let nz = dz * invLen;
  let scaleA = correction * weightA;
  let scaleB = correction * weightB;
  var aOut = aParticle;
  var bOut = bParticle;
  aOut.position = vec4f(aParticle.position.x + nx * scaleA,
    aParticle.position.y + ny * scaleA,
    aParticle.position.z + nz * scaleA, weightA);
  bOut.position = vec4f(bParticle.position.x - nx * scaleB,
    bParticle.position.y - ny * scaleB,
    bParticle.position.z - nz * scaleB, weightB);
  particles[aIndex] = aOut;
  particles[bIndex] = bOut;
}

// pass C:速度回算 + 三级固定归约树动能统计(定序归约的实现与证据)。
@compute @workgroup_size(64)
fn finalizeVelocityKinetics(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) localId: vec3u,
  @builtin(workgroup_id) workgroupId: vec3u) {
  let index = id.x;
  var lane = 0.0;
  if (index < params.particleCount) {
    let h = params.dtSeconds / f32(params.substeps);
    let invH = 1.0 / h;
    var particle = particles[index];
    if (particle.position.w == 0.0) {
      particle.velocity = vec4f(0.0);
    } else {
      let vx = (particle.position.x - particle.previous.x) * invH;
      let vy = (particle.position.y - particle.previous.y) * invH;
      let vz = (particle.position.z - particle.previous.z) * invH;
      particle.velocity = vec4f(vx, vy, vz, particle.velocity.w);
      lane = (vx * vx + vy * vy) + (vz * vz + 0.0);
    }
    particles[index] = particle;
  }
  laneKinetics[localId.x] = lane;
  workgroupBarrier();
  var level = DEEP_CLOTH_PARALLEL_WORKGROUP_SIZE;
  loop {
    if (level <= 1u) { break; }
    level = level >> 1u;
    if (localId.x < level) {
      laneKinetics[localId.x] = laneKinetics[localId.x * 2u] + laneKinetics[localId.x * 2u + 1u];
    }
    workgroupBarrier();
  }
  if (localId.x == 0u) {
    kineticPartials[workgroupId.x] = laneKinetics[0u];
  }
}

// pass B2:静态障碍接触投影(每粒子一 invocation;多障碍固定序循环;与 f64 黄金
// contacts.project 的 sphere 归一化/cuboid 最小轴推出逐式同构;锚点跳过)。
@compute @workgroup_size(64)
fn projectObstacles(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.particleCount) { return; }
  var particle = particles[index];
  if (particle.position.w == 0.0) { return; }
  var px = particle.position.x; var py = particle.position.y; var pz = particle.position.z;
  for (var o = 0u; o < obstacleRange.x; o += 1u) {
    let obstacle = obstacles[o];
    let dx = px - obstacle.center.x; let dy = py - obstacle.center.y; let dz = pz - obstacle.center.z;
    // 判别式合同:halfExtents.w = radius(sphere,>0)或 0(cuboid)——pack 端
    // (softBodyGpuDispatch.clothParallel.ts packClothGpuObstacles)槽 19 写入,两侧同源。
    if (obstacle.halfExtents.w > 0.0) {
      // sphere:归一化推到半径面(与 f64 黄金 sphere 分支同式)。
      let dist = sqrt(dx * dx + dy * dy + dz * dz);
      let radius = obstacle.center.w;
      if (dist < radius && dist > 0.0) {
        px = obstacle.center.x + dx / dist * radius;
        py = obstacle.center.y + dy / dist * radius;
        pz = obstacle.center.z + dz / dist * radius;
      } else if (dist == 0.0) {
        px = obstacle.center.x + radius; py = obstacle.center.y; pz = obstacle.center.z;
      }
    } else {
      // cuboid OBB:行主序旋转的转置把世界差映射进局部(局部半轴推到面)。
      let lx = obstacle.row0.x * dx + obstacle.row0.y * dy + obstacle.row0.z * dz;
      let ly = obstacle.row1.x * dx + obstacle.row1.y * dy + obstacle.row1.z * dz;
      let lz = obstacle.row2.x * dx + obstacle.row2.y * dy + obstacle.row2.z * dz;
      let hx = obstacle.halfExtents.x; let hy = obstacle.halfExtents.y; let hz = obstacle.halfExtents.z;
      let inside = (abs(lx) < hx) && (abs(ly) < hy) && (abs(lz) < hz);
      if (inside) {
        let penX = hx - abs(lx); let penY = hy - abs(ly); let penZ = hz - abs(lz);
        var localX = lx; var localY = ly; var localZ = lz;
        if (penX <= penY && penX <= penZ) { localX = select(lx, -hx, lx < 0.0) + select(0.0, hx, lx < 0.0); localX = sign(lx) * hx; }
        else if (penY <= penZ) { localY = sign(ly) * hy; }
        else { localZ = sign(lz) * hz; }
        // 局部→世界(转置旋转)。
        px = obstacle.center.x + obstacle.row0.x * localX + obstacle.row1.x * localY + obstacle.row2.x * localZ;
        py = obstacle.center.y + obstacle.row0.y * localX + obstacle.row1.y * localY + obstacle.row2.y * localZ;
        pz = obstacle.center.z + obstacle.row0.z * localX + obstacle.row1.z * localY + obstacle.row2.z * localZ;
      }
    }
  }
  particle.position = vec4f(px, py, pz, particle.position.w);
  particles[index] = particle;
}

// F6/T18:确定性风场 value noise(f32 移植)——hash 整数链与 terrainRandom.hashGrid2D
// 逐位同构(纯 u32),插值标量 f32;windEnabled=0 时 integrate 不触此路径(逐位退化)。
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
