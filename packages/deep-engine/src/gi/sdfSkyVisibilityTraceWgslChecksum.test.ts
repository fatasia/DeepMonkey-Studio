// Brief-GI M1 天光遮蔽 WGSL 单源 TS 半字节门禁(形态照抄 sdfCollisionQueryWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具(?raw sidecar)SHA-256/字节长对拍;
// 3) 确定性/域外 fail-open 合同字面锁定;4) Naga 语义校验。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/sdfSkyVisibilityTrace.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/sdfSkyVisibilityTrace.wgsl?raw";
import { DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL, SDF_SKY_VISIBILITY_ENTRY,
  SDF_SKY_VISIBILITY_LIMIT_EPSILON, SDF_SKY_VISIBILITY_MAX_STEPS,
  SDF_SKY_VISIBILITY_MIN_STEPS, SDF_SKY_VISIBILITY_PARAMS_BYTES,
  SDF_SKY_VISIBILITY_WORKGROUP_SIZE } from "./sdfSkyVisibilityTraceWgsl.js";
import { traceSdfSkyVisibility } from "./sdfSkyVisibility.js";
import { bakeSdfSceneGrid, type SdfSceneBakeInstance } from "./sdfSceneBake.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);
const NAGA = process.env.DEEP_SHADER_NAGA_BIN;

/** 最小可烘场景:两个 AABB 盒(12 三角形/个)。 */
function twoBoxInstances(): SdfSceneBakeInstance[] {
  const box = (min: readonly number[], max: readonly number[], id: string): SdfSceneBakeInstance =>
    ({ id, mesh: {
      positions: Float32Array.from([
        min[0], min[1], min[2], max[0], min[1], min[2], max[0], max[1], min[2], min[0], max[1], min[2],
        min[0], min[1], max[2], max[0], min[1], max[2], max[0], max[1], max[2], min[0], max[1], max[2],
      ]),
      indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
        3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]),
    } });
  return [box([0, 0, 0], [2, 1, 2], "box-a"), box([3, 0, 0], [5, 2, 2], "box-b")];
}

describe("SDF sky visibility trace WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the determinism + fail-open contract literals locked", () => {
    // 每 lane 独立输出:无 workgroup 共享内存、无原子 —— 同输入逐位回放:
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).not.toContain("atomic");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).not.toContain("var<workgroup>");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain(
      `@compute @workgroup_size(${SDF_SKY_VISIBILITY_WORKGROUP_SIZE})`);
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain(`fn ${SDF_SKY_VISIBILITY_ENTRY}(`);
    // 固定步数循环(无 early-break,break/continue 皆无 —— 时序无关逐位回放):
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain("for (var step = 0u; step < params.steps");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).not.toContain("break;");
    // 域外 fail-open(光照量 ≠ 安全量):域外 = 直达天空,不是 NaN:
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain("visibilities[lane] = 1.0;");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain("return 1000000.0;");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).not.toContain("bitcast");
    // 软阴影口径与除法下限(与 CPU 镜像 sdfSkyVisibility.ts 同字面):
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL)
      // GI-FIN:contribution 提前计算(首个 <1 步记命中距离),min 消费变量。
      .toContain("let contribution = clamp(distance / limit, 0.0, 1.0);")
      .toContain("if (hitDistance < 0.0 && contribution < 1.0) { hitDistance = t; }")
      .toContain("visibility = min(visibility, contribution);")
      .toContain("hitDistances[lane] = hitDistance;");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL)
      .toContain(`max(params.coneTan * t, ${SDF_SKY_VISIBILITY_LIMIT_EPSILON})`);
    // trilinear 采样序与碰撞查询核同构(x4 → y2 → z1):
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain("fn at(x: i32, y: i32, z: i32) -> f32");
    expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain("clamp(x, 0, d.x - 1)");
    // binding 布局与宿主打包互钉(group0:0 uniform + 1 field + 2 probes + 3 directions + 4 outputs):
    for (const binding of [0, 1, 2, 3, 4]) {
      expect(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL).toContain(`@binding(${binding})`);
    }
    expect(SDF_SKY_VISIBILITY_WORKGROUP_SIZE).toBe(64);
    expect(SDF_SKY_VISIBILITY_PARAMS_BYTES).toBe(48);
    expect(SDF_SKY_VISIBILITY_ENTRY).toBe("traceSkyVisibility");
    expect(SDF_SKY_VISIBILITY_MIN_STEPS).toBe(8);
    expect(SDF_SKY_VISIBILITY_MAX_STEPS).toBe(16);
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    const result = spawnSync(NAGA!,
      ["--stdin-file-path", "sdfSkyVisibilityTrace.wgsl", "--input-kind", "wgsl"], {
      input: sharedWgsl, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });

  it("CPU mirror: open sky stays 1, occluded directions drop, values bounded", () => {
    const { grid } = bakeSdfSceneGrid([
      twoBoxInstances()[0]!, twoBoxInstances()[1]!,
    ], { cellSize: 0.25, bounds: { min: [-0.5, -0.5, -0.5], max: [5.5, 3.5, 2.5] } });
    // 域外探针 fail-open 恒 1;域内探针(板上方)向上开放、向下穿板强遮蔽。
    const probes = [[10, 10, 10], [1, 1.5, 1], [4, 2.5, 1]] as const;
    const directions = [[0, 1, 0], [0, -1, 0], [1, 0, 0]] as const;
    const visibility = traceSdfSkyVisibility(grid, probes as unknown as [number, number, number][],
      directions as unknown as [number, number, number][], { steps: 8, coneTan: 0.1 });
    expect(visibility.length).toBe(probes.length * directions.length);
    for (const value of visibility) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // 域外探针(fail-open)三方向全 1:
    expect([...visibility.slice(0, 3)]).toEqual([1, 1, 1]);
    // 域内探针(盒 A 上方):向下(穿自身盒体)强遮蔽,向上开放:
    const first = visibility.slice(3, 6);
    expect(first[0]).toBeGreaterThan(0.5);   // +y 开放
    expect(first[1]).toBeLessThan(0.5);      // -y 穿盒
    // 域内探针(盒 B 上方):开放 +y 与遮蔽 -y 的方向对比成立:
    const second = visibility.slice(6, 9);
    expect(second[0]).toBeGreaterThan(second[1]!);
  });

  it("CPU mirror is deterministic (bitwise replay)", () => {
    const instances = twoBoxInstances();
    const { grid } = bakeSdfSceneGrid(instances, { cellSize: 0.25 });
    const probes = [[1, 1.2, 1], [4, 2.5, 1]] as const;
    const directions = [[0.3, 0.9, 0.2], [-0.5, 0.7, -0.4], [0.1, -1, 0.2]] as const;
    const a = traceSdfSkyVisibility(grid, probes as unknown as [number, number, number][],
      directions as unknown as [number, number, number][], { steps: 16 });
    const b = traceSdfSkyVisibility(grid, probes as unknown as [number, number, number][],
      directions as unknown as [number, number, number][], { steps: 16 });
    expect([...a]).toEqual([...b]);
  });
});
