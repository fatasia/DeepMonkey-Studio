// F6/T18 软体并行核 WGSL 字节门(形态照抄 clothSolverWgslChecksum.test.ts 的 TS 半):
// 1) 四入口与 workgroup 宽度互钉;2) ABI 常量(粒子/边/tet/params 字节)互钉;
// 3) 核结构锚点(per-particle 投影、色批 range uniform、params 风/障碍槽位)。
// 软体并行核当前为 TS 内嵌单源(无 Rust 半),跨宿主钉定沿 NVIDIA 单卡口径;
// Rust 半引入时再补 sidecar 双端逐位(登记于 f6-softbody-parallel-coloring 规格)。
import { describe, expect, it } from "vitest";
import {
  SOFT_BODY_PARALLEL_SOLVER_WGSL, SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE,
  SOFT_BODY_PARALLEL_ENTRY_INTEGRATE, SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES,
  SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES, SOFT_BODY_PARALLEL_ENTRY_FINALIZE,
  SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES,
} from "./softBodyParallelSolverWgsl.js";

describe("soft body parallel solver WGSL byte gate (TS half)", () => {
  it("keeps the four entry points and workgroup width locked", () => {
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain(`@compute @workgroup_size(${SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE})`);
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain(`fn ${SOFT_BODY_PARALLEL_ENTRY_INTEGRATE}(`);
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain(`fn ${SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES}(`);
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain(`fn ${SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES}(`);
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain(`fn ${SOFT_BODY_PARALLEL_ENTRY_FINALIZE}(`);
  });

  it("keeps the storage ABI contract literals locked", () => {
    // per-particle 投影(色批 range uniform 圈定,同色批无共享粒子):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let edgeIndex = colorRange.x + id.x;");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let tetIndex = colorRange.x + id.x;");
    // 积分 previous 只搬 xyz(w 槽保持 0 约定,与布料 A3 同纪律):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("particle.previous = particle.position;");
    // finalize 速度回算:
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("(particle.position.xyz - particle.previous.xyz) * invH");
    // 体积投影四角梯度(denominator 门禁同串行核):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("denominator += particles[ids[corner]].position.w * dot(gradients[corner], gradients[corner]);");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let correction = (tet.restVolume - volume) / (denominator + alphaVolume);");
  });

  // —— F6/T18 障碍刀:入口、绑定槽位与判别式/黄金同构锚点 ——
  it("keeps the obstacle projection entry and binding slots locked", () => {
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain(`fn ${SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES}(`);
    // 绑定 6/7(避开 0..5 既有槽位;params 48B 不动,不触 minBindingSize 断裂族):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("@group(0) @binding(6) var<storage, read> obstacles: array<Obstacle>;");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("@group(0) @binding(7) var<uniform> obstacleRange: vec4u;");
    // Obstacle struct 5×vec4f(80B,与布料核同 ABI):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("struct Obstacle {\n  center: vec4f,\n  row0: vec4f,\n  row1: vec4f,\n  row2: vec4f,\n  halfExtents: vec4f,\n}");
  });

  it("keeps the obstacle golden-isomorphic formula literals locked", () => {
    // 判别式合同(槽 19,pack 端 softBodyGpuWgsl.packSoftBodyGpuObstacles 同源):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("if (obstacle.halfExtents.w > 0.0) {");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let radius = obstacle.center.w;");
    // 跨界布局合同(rotation 9 floats 连续打包,vec4 视图 row0=(R00,R01,R02,R10)
    // row1=(R11,R12,R20,R21) row2=(R22,pad,pad,pad)——按行矩阵直觉消费=读错位,
    // r4 真机破案:identity/球静默无害、旋转 cuboid 全错,此处逐行字面钉死):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("R10=row0.w,R11=row1.x,R12=row1.y,R20=row1.z,R21=row1.w,R22=row2.x");
    // toLocal = Rᵀ·d(与 softBodyStaticCollision.ts 黄金逐式同构——非布料核的 R·d,
    // 旋转 cuboid 黄金一致性是本核的验收面):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let lx = obstacle.row0.x * dx + obstacle.row0.w * dy + obstacle.row1.z * dz;");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let ly = obstacle.row0.y * dx + obstacle.row1.x * dy + obstacle.row1.w * dz;");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("let lz = obstacle.row0.z * dx + obstacle.row1.y * dy + obstacle.row2.x * dz;");
    // 局部→世界 = center + R·local(黄金同构;y/z 行跨界取数):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("px = obstacle.center.x + obstacle.row0.x * localX + obstacle.row0.y * localY + obstacle.row0.z * localZ;");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("py = obstacle.center.y + obstacle.row0.w * localX + obstacle.row1.x * localY + obstacle.row1.y * localZ;");
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("pz = obstacle.center.z + obstacle.row1.z * localX + obstacle.row1.w * localY + obstacle.row2.x * localZ;");
    // 判定轴推出:select ±half(lx=0 归 +half,同黄金 (x<0?-1:1);非布料 sign()):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("localX = select(-hx, hx, lx >= 0.0);");
    // 锚点跳过(黄金 inverseMass==0 skip 同构):
    expect(SOFT_BODY_PARALLEL_SOLVER_WGSL).toContain("if (particle.position.w == 0.0) { return; }\n  var px = particle.position.x;");
  });
});
