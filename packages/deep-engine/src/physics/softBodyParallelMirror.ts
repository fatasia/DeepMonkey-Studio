// F6/T18 软体并行核·第三刀:色批序 f32 镜像(sourceSizeGate 职责拆分:与 GPU dispatch
// 编排分离,本文件只承担"并行核语义真值")。
import {
  projectEdge, projectVolume,
  packSoftBodyGpuParticles, validateSoftBodyGpuObstacles,
  type SoftBodyGpuObstacle, type SoftBodyGpuStepInput,
} from "./softBodyGpuWgsl.js";
// 风场刀:f32 噪声跨族单一真源(与布料镜像/WGSL windValueNoise 逐运算同构),禁复制。
import { mirrorWindNoise } from "./clothParallelSolver.js";

const f = Math.fround;


/**
 * 第三刀:色批序 f32 镜像——软体并行核语义真值。
 *
 * 与串行镜像(mirrorSoftBodyGpuStep,构建序投影)的差异仅投影序:并行编排每子步
 * integrate → 障碍投影(可选)→ 边色批(桶序)→ 体积色批(桶序)
 * → 障碍投影(可选)→ finalize；单约束复用 projectEdge/projectVolume。
 * 并行与串行彼此不逐位(投影序不同,布料换核合同同款声明);同核双跑逐位(无随机源)。
 * 障碍口径:输入序 = pack 序 = WGSL obstacleRange 序,三侧同序。
 * 障碍投影分别在积分后、约束后执行，与 CPU solver 的 contacts 边界一致。
 * 风场刀(F6/T18):integrate 段每子步消费 wind(噪声单一真源 mirrorWindNoise,
 * seed 混 WIND_NOISE_SALT 与布料/f64 黄金同源);风关路径与旧镜像逐位同构。
 */
export function mirrorSoftBodyParallelStep(
  input: SoftBodyGpuStepInput,
  edgeColoring: { colorRanges: ReadonlyArray<readonly [number, number]>; order: ArrayLike<number> },
  volumeColoring: { colorRanges: ReadonlyArray<readonly [number, number]>; order: ArrayLike<number> },
): Float32Array<ArrayBuffer> {
  if (input.obstacles) validateSoftBodyGpuObstacles(input.obstacles);
  const state = packSoftBodyGpuParticles(input.particles);
  const h = input.dtSeconds / input.substeps;
  const alphaEdge = input.complianceDistance / (h * h);
  const alphaVolume = input.complianceVolume / (h * h);
  const dampingScale = 1 - input.damping * h;
  const [gx, gy, gz] = input.gravity;
  // 风场刀(与布料 ClothParallelMirror 同式,差异仅在时间基来源:布料镜像有内部
  // tick 计数,本镜像无状态——tick 基由输入 wind.tickSeconds 提供,子步递进 +sub·h,
  // 与 dispatch pack 的 per-substep 副本同表达式 f64 累加后一次 fround):
  const wind = input.wind;
  const noiseSeed = wind ? ((wind.seed ^ 0x51ed2701) >>> 0) : 0;
  const gustF = wind ? f(wind.gustFrequency) : 0;
  const spatial = wind ? f(wind.spatialScale) : 0;
  const baseSpeed = wind ? f(wind.baseSpeed) : 0;
  const wdx = wind ? f(wind.direction[0]) : 0;
  const wdy = wind ? f(wind.direction[1]) : 0;
  const wdz = wind ? f(wind.direction[2]) : 0;

  for (let substep = 0; substep < input.substeps; substep += 1) {
    // 风时间基:tick 基 + sub·h(f64 累加一次舍入,与 pack per-substep 副本同表达式同值)。
    // 噪声本身逐运算 fround(mirrorWindNoise 单一真源);积分折算保持本文件既有非
    // fround 风格(与串行镜像逐位退化合同绑定)——风关时 (gx+0)·h ≡ gx·h 逐位,零风
    // 路径与旧镜像逐位同构;风开的 f32-vs-f64 折算差由 GPU vs 镜像容差口径承担
    // (与障碍刀 4.16e-4@120t 同族,门 0.05)。
    const tickSeconds = wind ? f(wind.tickSeconds + substep * (input.dtSeconds / input.substeps)) : 0;
    const windAt = (y: number): readonly [number, number, number] => {
      if (!wind) return [0, 0, 0];
      const n = f(mirrorWindNoise(f(f(tickSeconds) * gustF), f(y * spatial), noiseSeed));
      const speed = f(baseSpeed * f(0.5 + n));
      return [f(wdx * speed), f(wdy * speed), f(wdz * speed)];
    };
    for (let i = 0; i < input.particles.length; i += 1) {
      const base = i * 12;
      state[base + 8] = state[base]!; state[base + 9] = state[base + 1]!; state[base + 10] = state[base + 2]!;
      const inverseMass = state[base + 3]!;
      if (inverseMass === 0) { state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0; continue; }
      const [wx, wy, wz] = windAt(state[base + 1]!);
      state[base + 4] = (state[base + 4]! + (gx + wx) * h) * dampingScale;
      state[base + 5] = (state[base + 5]! + (gy + wy) * h) * dampingScale;
      state[base + 6] = (state[base + 6]! + (gz + wz) * h) * dampingScale;
      state[base] = state[base]! + state[base + 4]! * h;
      state[base + 1] = state[base + 1]! + state[base + 5]! * h;
      state[base + 2] = state[base + 2]! + state[base + 6]! * h;
    }
    // 障碍投影:与 GPU pass 序同位(integrate 后、色批前),输入序 = WGSL obstacleRange 序。
    if (input.obstacles) {
      for (const obstacle of input.obstacles) projectObstacle(state, obstacle);
    }
    // 边色批:桶序(与 GPU colorRange 编排一致)。
    for (let bucket = 0; bucket < edgeColoring.colorRanges.length; bucket += 1) {
      const [start, end] = edgeColoring.colorRanges[bucket]!;
      for (let slot = start; slot < end; slot += 1) {
        const k = edgeColoring.order[slot]!;
        projectEdge(state, input.edges[k]!, alphaEdge);
      }
    }
    // 体积色批:桶序。
    for (let bucket = 0; bucket < volumeColoring.colorRanges.length; bucket += 1) {
      const [start, end] = volumeColoring.colorRanges[bucket]!;
      for (let slot = start; slot < end; slot += 1) {
        const k = volumeColoring.order[slot]!;
        projectVolume(state, input.tets[k]!, alphaVolume);
      }
    }
    if (input.obstacles) {
      for (const obstacle of input.obstacles) projectObstacle(state, obstacle);
    }
    const inverseH = 1 / h;
    for (let i = 0; i < input.particles.length; i += 1) {
      const base = i * 12;
      if (state[base + 3] === 0) { state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0; continue; }
      state[base + 4] = (state[base]! - state[base + 8]!) * inverseH;
      state[base + 5] = (state[base + 1]! - state[base + 9]!) * inverseH;
      state[base + 6] = (state[base + 2]! - state[base + 10]!) * inverseH;
    }
  }
  return state;
}

/**
 * 障碍投影镜像(WGSL projectObstaclesSoftBody 的 f64 精度同 op 序模型)。
 *
 * 与 f64 黄金 softBodyStaticCollision.ts 逐式同构:toLocal = Rᵀ·d(行主序转置)、
 * world = center + R·local、sphere 归一化半径面、判定轴 ±half(x==0 归 +half)、
 * 锚点跳过;与 WGSL 的差异仅数值精度(f64 vs f32),GPU vs 镜像由容差口径承担。
 * 判别式与 WGSL 同源:radius>0 = sphere(镜像读对象字段,WGSL 读槽 3/19——字节层
 * 一致性由 ABI 锁保证)。单遍循环,无 4-sweep 收敛(与 WGSL/布料先例同边界)。
 */
export function projectObstacle(state: Float32Array, obstacle: SoftBodyGpuObstacle): void {
  const particleCount = state.length / 12;
  const [cx, cy, cz] = obstacle.center;
  const rotation = obstacle.rotation;
  const [hx, hy, hz] = obstacle.halfExtents;
  for (let index = 0; index < particleCount; index += 1) {
    const base = index * 12;
    if (state[base + 3] === 0) continue; // 锚点跳过(黄金 inverseMass==0 同构)。
    const px = state[base]!; const py = state[base + 1]!; const pz = state[base + 2]!;
    const dx = px - cx; const dy = py - cy; const dz = pz - cz;
    let outX = px; let outY = py; let outZ = pz;
    if (obstacle.radius > 0) {
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < obstacle.radius && dist > 0) {
        outX = cx + dx / dist * obstacle.radius;
        outY = cy + dy / dist * obstacle.radius;
        outZ = cz + dz / dist * obstacle.radius;
      } else if (dist === 0) {
        // 中心退化:沿旋转后 x 轴推出(local=(radius,0,0) → world = R·local,黄金同构)。
        outX = cx + rotation[0]! * obstacle.radius;
        outY = cy + rotation[3]! * obstacle.radius;
        outZ = cz + rotation[6]! * obstacle.radius;
      }
    } else if (Math.abs(rotation[0]! * dx + rotation[3]! * dy + rotation[6]! * dz) < hx
      && Math.abs(rotation[1]! * dx + rotation[4]! * dy + rotation[7]! * dz) < hy
      && Math.abs(rotation[2]! * dx + rotation[5]! * dy + rotation[8]! * dz) < hz) {
      const lx = rotation[0]! * dx + rotation[3]! * dy + rotation[6]! * dz;
      const ly = rotation[1]! * dx + rotation[4]! * dy + rotation[7]! * dz;
      const lz = rotation[2]! * dx + rotation[5]! * dy + rotation[8]! * dz;
      const penX = hx - Math.abs(lx); const penY = hy - Math.abs(ly); const penZ = hz - Math.abs(lz);
      let localX = lx; let localY = ly; let localZ = lz;
      if (penX <= penY && penX <= penZ) { localX = lx < 0 ? -hx : hx; }
      else if (penY <= penZ) { localY = ly < 0 ? -hy : hy; }
      else { localZ = lz < 0 ? -hz : hz; }
      outX = cx + rotation[0]! * localX + rotation[1]! * localY + rotation[2]! * localZ;
      outY = cy + rotation[3]! * localX + rotation[4]! * localY + rotation[5]! * localZ;
      outZ = cz + rotation[6]! * localX + rotation[7]! * localY + rotation[8]! * localZ;
    }
    state[base] = outX; state[base + 1] = outY; state[base + 2] = outZ;
  }
}
