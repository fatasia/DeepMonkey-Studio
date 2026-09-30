// A2 SDF 碰撞 profile WGSL 单源 TS 半字节门禁(形态照抄 clothSolverWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具(?raw sidecar)跨宿主对拍 —— Rust 半在
// deep-engine-native/tests/sdf_collision_profile_truth.rs,测试文件内自带纯 Rust
// SHA-256,同一夹具两侧各自重算;3) 核结构字面与 ABI 常量互钉(含确定性合同:
// 无原子/无 workgroup 内存/i32 钳制/域外 fail-closed NaN 位型);4) Naga 语义校验。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/sdfCollisionQuery.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/sdfCollisionQuery.wgsl?raw";
import { DEEP_SDF_COLLISION_QUERY_WGSL, SDF_QUERY_ENTRY, SDF_QUERY_MAX_POINTS, SDF_QUERY_NAN_BITS,
  SDF_QUERY_PARAMS_BYTES, SDF_QUERY_WORKGROUP_SIZE } from "./sdfCollisionQueryWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);
const NAGA = process.env.DEEP_SHADER_NAGA_BIN;

describe("SDF collision query WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_SDF_COLLISION_QUERY_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the determinism + fail-closed contract literals locked", () => {
    // 每 lane 独立输出:无 workgroup 共享内存、无原子 —— 无归约定序需求,同输入逐位回放:
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).not.toContain("atomic");
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).not.toContain("var<workgroup>");
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain(`@compute @workgroup_size(${SDF_QUERY_WORKGROUP_SIZE})`);
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain(`fn ${SDF_QUERY_ENTRY}(`);
    // i32 钳制取值(u32 减法在 0 处会回绕到远侧,这是实测踩出来的坑):
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain("fn at(x: i32, y: i32, z: i32) -> f32");
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain("clamp(x, 0, d.x - 1)");
    // 域外 fail-closed:quiet NaN 位型 + 状态字,绝不静默「无碰撞」:
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain("bitcast<f32>(0x7fc00000u)");
    expect(SDF_QUERY_NAN_BITS).toBe(0x7fc00000);
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain("statuses[gid.x] = 1u;");
    // trilinear + 中心差分梯度(固定 stencil 序 x→y→z):
    expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain("(at(lx + 1, ly, lz) - at(lx - 1, ly, lz)) / (2.0 * h)");
    // binding 布局与宿主打包互钉(group0:0 uniform + 1 field + 2 queries + 3 results + 4 statuses):
    for (const binding of [0, 1, 2, 3, 4]) {
      expect(DEEP_SDF_COLLISION_QUERY_WGSL).toContain(`@binding(${binding})`);
    }
  });

  it("keeps the ABI constants pinned to the host packer contract", () => {
    expect(SDF_QUERY_WORKGROUP_SIZE).toBe(64);
    expect(SDF_QUERY_PARAMS_BYTES).toBe(48);
    expect(SDF_QUERY_ENTRY).toBe("queryCollisions");
    expect(SDF_QUERY_MAX_POINTS).toBe(65_536);
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    const result = spawnSync(NAGA!, ["--stdin-file-path", "sdfCollisionQuery.wgsl", "--input-kind", "wgsl"], {
      input: sharedWgsl, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });
});
