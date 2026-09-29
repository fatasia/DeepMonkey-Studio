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
  _padding1: f32,
  gravity: vec4f,
}
struct ClothStepRange {
  rangeStart: u32,
  rangeEnd: u32,
  _padding0: u32,
  _padding1: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<ClothParticle>;
@group(0) @binding(1) var<storage, read> constraints: array<ClothConstraint>;
@group(0) @binding(2) var<uniform> params: ClothParams;
@group(0) @binding(3) var<uniform> stepRange: ClothStepRange;
@group(0) @binding(4) var<storage, read_write> kineticPartials: array<f32>;

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
  let vx = (particle.velocity.x + params.gravity.x * h) * dampingScale;
  let vy = (particle.velocity.y + params.gravity.y * h) * dampingScale;
  let vz = (particle.velocity.z + params.gravity.z * h) * dampingScale;
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
