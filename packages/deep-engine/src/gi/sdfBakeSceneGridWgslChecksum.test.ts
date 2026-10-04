// Brief-GI M3 SDF 场景烘焙 WGSL 单源 TS 半字节门禁(形态照抄 sdfGiPublishWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具(?raw sidecar)SHA-256/字节长对拍;
// 3) CPU 同构公式/域裁剪/合成恒等合同字面锁定;4) Naga 语义校验(env 门控)。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/sdfBakeSceneGrid.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/sdfBakeSceneGrid.wgsl?raw";
import { DEEP_SDF_BAKE_SCENE_GRID_WGSL, SDF_BAKE_SCENE_GRID_ENTRY,
  SDF_BAKE_SCENE_GRID_MAX_TRIANGLES, SDF_BAKE_SCENE_GRID_PARAMS_BYTES,
  SDF_BAKE_SCENE_GRID_TRIANGLE_VEC4S, SDF_BAKE_SCENE_GRID_WORKGROUP_SIZE } from "./sdfBakeSceneGridWgsl.js";
import { MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES } from "./sdfSceneBakeGrid.js";
import { MAX_SDF_PROFILE_GRID_CELLS } from "../physics/sdfCollisionProfile.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);
const NAGA = process.env.DEEP_SHADER_NAGA_BIN;

describe("SDF bake scene grid WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_SDF_BAKE_SCENE_GRID_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the CPU-isomorphic formula + domain clipping + composite identity literals locked", () => {
    // 每 lane 独立烘焙一个 cell:无 workgroup 共享内存、无原子 —— 同输入逐位回放。
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).not.toContain("atomic");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).not.toContain("var<workgroup>");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL)
      .toContain(`@compute @workgroup_size(${SDF_BAKE_SCENE_GRID_WORKGROUP_SIZE})`);
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain(`fn ${SDF_BAKE_SCENE_GRID_ENTRY}(`);
    // 距离/定号与 CPU 权威(buildSdfGrid.triangleDistance/rayX)同式:
    // 顶点/边/面三分支 + Möller–Trumbore(±1e-8 容差、t>1e-8)。
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain("fn triangleDistance(");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain("fn rayXHits(");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain("if (u < -1e-8 || u > 1.0 + 1e-8) { return false; }");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain("return t > 1e-8;");
    // 实例域裁剪(round 舍入界,与 composeInstance 的 round 查找一致):
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL)
      .toContain("let local = round((p - domainOrigin) / params.cellSize);");
    // 合成恒等:field = sign × min(nearest, exteriorDistance)
    // ≡ CPU 的「初始 exteriorDistance + min 合成 + 负值钳 −exteriorDistance」。
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain("field[linear] = sign * nearest;");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).toContain("var nearest = params.exteriorDistance;");
    // 三角形固定序遍历(输入序,无 early-break,时序无关逐位回放):
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL)
      .toContain("for (var index = 0u; index < params.triangleCount; index = index + 1u)");
    expect(DEEP_SDF_BAKE_SCENE_GRID_WGSL).not.toContain("break;");
    // 预算与 ABI 互钉(宿主回退线/GPU 侧预算):
    expect(SDF_BAKE_SCENE_GRID_WORKGROUP_SIZE).toBe(64);
    expect(SDF_BAKE_SCENE_GRID_PARAMS_BYTES).toBe(64); // vec3f 对齐 16 → origin@32,struct 64B
    expect(SDF_BAKE_SCENE_GRID_TRIANGLE_VEC4S).toBe(5);
    expect(SDF_BAKE_SCENE_GRID_ENTRY).toBe("sdfBakeSceneGridMain");
    expect(SDF_BAKE_SCENE_GRID_MAX_TRIANGLES).toBe(65536);
    expect(MAX_SDF_PROFILE_GRID_CELLS).toBeGreaterThan(0);
    expect(MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES).toBeGreaterThan(0);
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    const result = spawnSync(NAGA!,
      ["--stdin-file-path", "sdfBakeSceneGrid.wgsl", "--input-kind", "wgsl"], {
      input: sharedWgsl, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });
});
