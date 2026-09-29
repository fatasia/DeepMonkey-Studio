// T18 A3 并行布料 WGSL 单源 TS 半字节门禁(形态照抄 ltcAreaLightingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具(?raw sidecar)跨宿主对拍 —— Rust 半在
// deep-engine-native/tests/cloth_parallel_compute_parity.rs,测试文件内自带纯 Rust
// SHA-256,同一夹具两侧各自重算;3) 核结构字面与 ABI 常量互钉;4) Naga 语义校验。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/clothSolver.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/clothSolver.wgsl?raw";
import { DEEP_CLOTH_PARALLEL_SOLVER_WGSL, CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE,
  CLOTH_PARALLEL_PARTICLE_STRIDE_BYTES, CLOTH_PARALLEL_CONSTRAINT_STRIDE_BYTES,
  CLOTH_PARALLEL_PARAMS_BYTES, CLOTH_PARALLEL_STEP_RANGE_BYTES,
  CLOTH_PARALLEL_ENTRY_INTEGRATE, CLOTH_PARALLEL_ENTRY_PROJECT, CLOTH_PARALLEL_ENTRY_FINALIZE } from "./clothSolverWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);
const NAGA = process.env.DEEP_SHADER_NAGA_BIN;

describe("cloth parallel solver WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_CLOTH_PARALLEL_SOLVER_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the execution-order contract literals locked (coloring + fixed reduction tree)", () => {
    // 三 pass 入口与 workgroup 宽度:
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain(`@compute @workgroup_size(${CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE})`);
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain(`fn ${CLOTH_PARALLEL_ENTRY_INTEGRATE}(`);
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain(`fn ${CLOTH_PARALLEL_ENTRY_PROJECT}(`);
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain(`fn ${CLOTH_PARALLEL_ENTRY_FINALIZE}(`);
    // 色序投影按 [rangeStart, rangeEnd) 桶区间取约束(色间 dispatch 定序):
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("let bucket = stepRange.rangeStart + id.x;");
    // 投影标量展开与 clothParallelSolver.ts 逐运算同构的锚点(invLen 乘法,非除法):
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("let invLen = 1.0 / len;");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("let scaleA = correction * weightA;");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("let scaleB = correction * weightB;");
    // 固定归约树:64 lane 共享内存 pairwise,levels 由位移推进,无原子:
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("var<workgroup> laneKinetics: array<f32, 64>;");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("level = level >> 1u;");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).not.toContain("atomic");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("kineticPartials[workgroupId.x] = laneKinetics[0u];");
  });

  it("keeps the storage ABI byte strides pinned to the host packer contract", () => {
    expect(CLOTH_PARALLEL_PARTICLE_STRIDE_BYTES).toBe(48);
    expect(CLOTH_PARALLEL_CONSTRAINT_STRIDE_BYTES).toBe(16);
    expect(CLOTH_PARALLEL_PARAMS_BYTES).toBe(48);
    expect(CLOTH_PARALLEL_STEP_RANGE_BYTES).toBe(16);
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("position: vec4f,\n  velocity: vec4f,\n  previous: vec4f,");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("a: u32,\n  b: u32,\n  restLength: f32,\n  _padding: u32,");
    expect(DEEP_CLOTH_PARALLEL_SOLVER_WGSL).toContain("rangeStart: u32,\n  rangeEnd: u32,");
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    const result = spawnSync(NAGA!, ["--stdin-file-path", "clothSolver.wgsl", "--input-kind", "wgsl"], {
      input: sharedWgsl, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });
});
