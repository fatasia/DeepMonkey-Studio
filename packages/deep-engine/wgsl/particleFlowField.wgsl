// I 级 C17 节点化/流场粒子首刀:curl-noise 流场驱动的粒子 compute 核(唯一真源,
// TS 镜像由 scripts/syncSharedWgsl.mjs 生成,纯 TS 消费,无 Rust 半)。修改流程:
// 改本文件 → pnpm --filter @bim-studio/deep-engine wgsl:sync → 同一提交带 .wgsl +
// 生成镜像 + .sha256 三件套(三者不同步时字节门禁测试失败)。
//
// 机制层对标 Babylon/kn-force 节点粒子的流场驱动(只取 curl noise 机制,不取其节点
// 编辑器面):势场 ψ=(n1,n2,n3) 为三路去相关解析梯度噪声,速度 v=∇×ψ 数学上严格
// 无散(Bridson curl noise),粒子不会向场汇聚集。梯度偏导为闭式(非有限差分),
// 每粒子每帧 3 次噪声求值、每噪声 8 角点,表达式树与 CPU 镜像 flowFieldNoise.ts
// 逐运算同构(同常量、同次序、显式加权和,不用 mix/dot 内建以免后端契约差异)。
//
// 确定性合同(与 T20 同纪律):同 seed 同场逐位——场只依赖 (position, seed, scale,
// phase);CPU 镜像逐运算 f32 舍入,跨主机锚定靠本文件 SHA-256;GPU f32 逐位对拍
// 与 FMA 契约留真机联测(CPU 镜像是不含 FMA 的 IEEE f32 参考)。
//
// 与既有 simulateAndCompact(gpuParticleWgsl.ts)的关系:绑定 0..5 完全同构,仅新增
// binding 6 流场 uniform;积分/回绕/有限守卫/压缩五段与既有核逐行同文(家族锁步
// 测试 gpuParticleFlowFieldWgslChecksum.test.ts 守护),flowStrength=0 时本核与既有
// 核在同一输入下产生逐位相同的状态(±0 语义除外,见镜像注释)。

struct Particle {
  positionAge: vec4f,
  velocityLifetime: vec4f,
  color: vec4f,
  sizeRotationId: vec4f,
}
struct Counter { value: atomic<u32> }
struct FrameParams {
  deltaTime: f32,
  drag: f32,
  capacity: u32,
  _padding: u32,
  acceleration: vec4f,
}
struct FlowParams {
  phase: f32,
  noiseScale: f32,
  flowSpeed: f32,
  flowStrength: f32,
  maxSpeed: f32,
  _pad0: f32,
  seed: u32,
  _pad1: u32,
}
@group(0) @binding(0) var<storage, read> inputParticles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> inputCounter: Counter;
@group(0) @binding(2) var<storage, read_write> outputParticles: array<Particle>;
@group(0) @binding(3) var<storage, read_write> outputCounter: Counter;
@group(0) @binding(4) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(5) var<uniform> frame: FrameParams;
@group(0) @binding(6) var<uniform> flow: FlowParams;

// 采样域硬限:position×scale 可达 1e15,f32→i32 转换越界为未定义,必须先钳。
// 钳制 plateau 在 |q|>1e6 才出现(典型场景 scale≤2、|p|≤1e3 时 q≤2e3,远不可达)。
const DEEP_FLOW_DOMAIN_LIMIT = 1000000.0;
// 势场去相关种子混入量(互异素数,host 镜像同字面)。
const DEEP_FLOW_POTENTIAL_A = 1474034859u;
const DEEP_FLOW_POTENTIAL_B = 645307069u;
const DEEP_FLOW_POTENTIAL_C = 752542313u;

fn deepFlowHash(x: i32, y: i32, z: i32, seed: u32) -> vec3f {
  var h = (u32(x) * 374761393u) ^ (u32(y) * 668265263u) ^ (u32(z) * 1274126177u) ^ seed;
  h = (h ^ (h >> 13u)) * 2246822519u;
  h = h ^ (h >> 16u);
  return vec3f(f32(h & 0xFFFFu) / 32768.0 - 1.0,
    f32((h >> 7u) & 0xFFFFu) / 32768.0 - 1.0,
    f32((h >> 14u) & 0xFFFFu) / 32768.0 - 1.0);
}

// 五次平滑 w=t³(6t²−15t+10) 与 w'=30t²(t−1)²;返回 (w, dw)。
// 表达式次序与 flowFieldNoise.ts::flowFade 逐运算一致,任何重排都是语义漂移。
fn deepFlowFade(t: f32) -> vec2f {
  let t2 = t * t;
  let t3 = t2 * t;
  let w = t3 * (t2 * 6.0 - t * 15.0 + 10.0);
  let dw = t2 * ((t - 1.0) * (t - 1.0)) * 30.0;
  return vec2f(w, dw);
}

// 单路解析梯度噪声:返回 (value, d/dx, d/dy, d/dz)。叶偏导=梯度分量本身
// (d(dot(g, p−corner))/dp = g),链式偏导经 lerp 累加,与 CPU 镜像同构。
struct DeepFlowSample {
  value: f32,
  dx: f32,
  dy: f32,
  dz: f32,
}
fn deepFlowGradientNoise(p: vec3f, seed: u32) -> DeepFlowSample {
  let base = floor(p);
  let f = p - base;
  let i = vec3i(base);
  let u = deepFlowFade(f.x);
  let v = deepFlowFade(f.y);
  let w = deepFlowFade(f.z);
  let g000 = deepFlowHash(i.x, i.y, i.z, seed);
  let g100 = deepFlowHash(i.x + 1, i.y, i.z, seed);
  let g010 = deepFlowHash(i.x, i.y + 1, i.z, seed);
  let g110 = deepFlowHash(i.x + 1, i.y + 1, i.z, seed);
  let g001 = deepFlowHash(i.x, i.y, i.z + 1, seed);
  let g101 = deepFlowHash(i.x + 1, i.y, i.z + 1, seed);
  let g011 = deepFlowHash(i.x, i.y + 1, i.z + 1, seed);
  let g111 = deepFlowHash(i.x + 1, i.y + 1, i.z + 1, seed);
  let r100 = f - vec3f(1.0, 0.0, 0.0);
  let r010 = f - vec3f(0.0, 1.0, 0.0);
  let r110 = f - vec3f(1.0, 1.0, 0.0);
  let r001 = f - vec3f(0.0, 0.0, 1.0);
  let r101 = f - vec3f(1.0, 0.0, 1.0);
  let r011 = f - vec3f(0.0, 1.0, 1.0);
  let r111 = f - vec3f(1.0, 1.0, 1.0);
  let d000 = g000.x * f.x + g000.y * f.y + g000.z * f.z;
  let d100 = g100.x * r100.x + g100.y * r100.y + g100.z * r100.z;
  let d010 = g010.x * r010.x + g010.y * r010.y + g010.z * r010.z;
  let d110 = g110.x * r110.x + g110.y * r110.y + g110.z * r110.z;
  let d001 = g001.x * r001.x + g001.y * r001.y + g001.z * r001.z;
  let d101 = g101.x * r101.x + g101.y * r101.y + g101.z * r101.z;
  let d011 = g011.x * r011.x + g011.y * r011.y + g011.z * r011.z;
  let d111 = g111.x * r111.x + g111.y * r111.y + g111.z * r111.z;
  let lx = 1.0 - u.x;
  let ly = 1.0 - v.x;
  let lz = 1.0 - w.x;
  // z=0 平面:ax=x 向 lerp@y0z0,bx=x 向 lerp@y1z0,z0=y 向 lerp@z0。
  let ax = lx * d000 + u.x * d100;
  let axdx = lx * g000.x + u.x * g100.x + u.y * (d100 - d000);
  let axdy = lx * g000.y + u.x * g100.y;
  let axdz = lx * g000.z + u.x * g100.z;
  let bx = lx * d010 + u.x * d110;
  let bxdx = lx * g010.x + u.x * g110.x + u.y * (d110 - d010);
  let bxdy = lx * g010.y + u.x * g110.y;
  let bxdz = lx * g010.z + u.x * g110.z;
  let z0 = ly * ax + v.x * bx;
  let z0dx = ly * axdx + v.x * bxdx;
  let z0dy = ly * axdy + v.x * bxdy + v.y * (bx - ax);
  let z0dz = ly * axdz + v.x * bxdz;
  // z=1 平面:cx=x 向 lerp@y0z1,ex=x 向 lerp@y1z1,z1=y 向 lerp@z1。
  let cx = lx * d001 + u.x * d101;
  let cxdx = lx * g001.x + u.x * g101.x + u.y * (d101 - d001);
  let cxdy = lx * g001.y + u.x * g101.y;
  let cxdz = lx * g001.z + u.x * g101.z;
  let ex = lx * d011 + u.x * d111;
  let exdx = lx * g011.x + u.x * g111.x + u.y * (d111 - d011);
  let exdy = lx * g011.y + u.x * g111.y;
  let exdz = lx * g011.z + u.x * g111.z;
  let z1 = ly * cx + v.x * ex;
  let z1dx = ly * cxdx + v.x * exdx;
  let z1dy = ly * cxdy + v.x * exdy + v.y * (ex - cx);
  let z1dz = ly * cxdz + v.x * exdz;
  var output: DeepFlowSample;
  output.value = lz * z0 + w.x * z1;
  output.dx = lz * z0dx + w.x * z1dx;
  output.dy = lz * z0dy + w.x * z1dy;
  output.dz = lz * z0dz + w.x * z1dz + w.y * (z1 - z0);
  return output;
}

// curl=∇×ψ:ψ=(n_a,n_b,n_c),v=(∂c/∂y−∂b/∂z, ∂a/∂z−∂c/∂x, ∂b/∂x−∂a/∂y),
// 严格无散(每分量是另一势场的偏导组合,∂v/∂ 交叉相消)。
fn deepFlowCurlVelocity(p: vec3f, seed: u32) -> vec3f {
  let a = deepFlowGradientNoise(p, seed ^ DEEP_FLOW_POTENTIAL_A);
  let b = deepFlowGradientNoise(p, seed ^ DEEP_FLOW_POTENTIAL_B);
  let c = deepFlowGradientNoise(p, seed ^ DEEP_FLOW_POTENTIAL_C);
  return vec3f(c.dy - b.dz, a.dz - c.dx, b.dx - a.dy);
}

// 流场推进核:与 simulateAndCompact 同构(绑定 0..5 逐项一致),仅速度更新前
// 插入 curl 场引导(guided=(1−k)·v+k·v_field,k=1−exp(−strength·dt))与可选
// maxSpeed 硬帽;flowStrength=0 ⇒ k=0 ⇒ guided 逐位退化回原速度(±0 语义除外)。
@compute @workgroup_size(64)
fn simulateAndCompactFlow(@builtin(global_invocation_id) id: vec3u) {
  let inputCount = min(atomicLoad(&inputCounter.value), frame.capacity);
  if (id.x >= inputCount) { return; }
  var particle = inputParticles[id.x];
  var age = particle.positionAge.w + frame.deltaTime;
  let lifetime = particle.velocityLifetime.w;
  let flags = u32(round(particle.sizeRotationId.w));
  let looping = (flags & 1u) != 0u;
  if (age >= lifetime && !looping) { return; }
  let query = clamp(particle.positionAge.xyz * flow.noiseScale - vec3f(0.0, 0.0, flow.phase),
    vec3f(-DEEP_FLOW_DOMAIN_LIMIT), vec3f(DEEP_FLOW_DOMAIN_LIMIT));
  let fieldVelocity = deepFlowCurlVelocity(query, flow.seed) * flow.flowSpeed;
  let follow = 1.0 - exp(-flow.flowStrength * frame.deltaTime);
  let guided = (1.0 - follow) * particle.velocityLifetime.xyz + follow * fieldVelocity;
  let damping = exp(-frame.drag * frame.deltaTime);
  var velocity = (guided + frame.acceleration.xyz * frame.deltaTime) * damping;
  let speed = length(velocity);
  velocity = select(velocity, velocity * (flow.maxSpeed / max(speed, 1e-9)),
    flow.maxSpeed > 0.0 && speed > flow.maxSpeed);
  var position = particle.positionAge.xyz + velocity * frame.deltaTime;
  if (looping && age >= lifetime) {
    let cycles = floor(age / lifetime);
    age -= cycles * lifetime; position -= velocity * lifetime * cycles;
  }
  particle.positionAge = vec4f(position, age);
  particle.velocityLifetime = vec4f(velocity, particle.velocityLifetime.w);
  let finitePosition = all(position == position) && all(abs(position) <= vec3f(3.402823e38));
  let finiteVelocity = all(velocity == velocity) && all(abs(velocity) <= vec3f(3.402823e38));
  if (!finitePosition || !finiteVelocity) { return; }
  let destination = atomicAdd(&outputCounter.value, 1u);
  if (destination < frame.capacity) { outputParticles[destination] = particle; }
}
