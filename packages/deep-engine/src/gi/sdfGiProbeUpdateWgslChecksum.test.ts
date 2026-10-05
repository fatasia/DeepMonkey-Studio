// Brief-GI M2 探针 SH 更新 WGSL 单源 TS 半字节门禁(形态照抄 sdfSkyVisibilityTraceWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具(?raw sidecar)SHA-256/字节长对拍;
// 3) 确定性/F5 不写/埋入透传合同字面锁定;4) Naga 语义校验(env 门控)。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/sdfGiProbeUpdate.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/sdfGiProbeUpdate.wgsl?raw";
import { DEEP_SDF_GI_PROBE_UPDATE_WGSL, SDF_GI_PROBE_UPDATE_BOUNCE_ENERGY_LIMIT,
  SDF_GI_PROBE_UPDATE_ENTRY, SDF_GI_PROBE_UPDATE_PARAMS_BYTES,
  SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE, SDF_GI_PROBE_RECORD_VEC4_STRIDE } from "./sdfGiProbeUpdateWgsl.js";
import { updateProbeShWithSdfGi, DEEP_GI_PROBE_TEMPORAL_ALPHA } from "./probeShUpdate.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);
const NAGA = process.env.DEEP_SHADER_NAGA_BIN;

describe("SDF GI probe update WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_SDF_GI_PROBE_UPDATE_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the determinism + F5 passthrough contract literals locked", () => {
    // 每 lane 独立读写自己的记录行:无 workgroup 共享内存、无原子 —— 同输入逐位回放:
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).not.toContain("atomic");
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).not.toContain("var<workgroup>");
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL)
      .toContain(`@compute @workgroup_size(${SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE})`);
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain(`fn ${SDF_GI_PROBE_UPDATE_ENTRY}(`);
    // 固定步数方向循环(无 early-break,时序无关逐位回放):
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain("for (var d = 0u; d < count; d = d + 1u)");
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).not.toContain("break;");
    // F5 合同:words[12..23](vec4[3..5])绝不写 —— 本核只写 vec4[0] 与 vec4[1]:
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain("records[base]");
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain("records[base + 1u]");
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).not.toMatch(/records\[base \+ [2-5]u\]/);
    // 埋入探针透传(validity==0 早退,整行不动):
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain("if (current.w == 0.0) { return; }");
    // `target` 是 WGSL 保留字:目标场命名 targetField(命名回归守卫):
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain("let targetField");
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).not.toMatch(/\blet target\b/);
    // 时域滤波与 CPU 域同式:out = prev + (target − prev)·α:
    expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL)
      .toContain("current.xyz + (finalTarget - current.xyz) * params.alpha");
    // binding 布局与宿主打包互钉(group0:0 uniform + 1 visibility + 2 radiance + 3 records):
    for (const binding of [0, 1, 2, 3]) {
      expect(DEEP_SDF_GI_PROBE_UPDATE_WGSL).toContain(`@binding(${binding})`);
    }
    expect(SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE).toBe(64);
    // GI-FIN:uniform 扩到 64B(bounceAlbedo vec4 + maxDistance f32,命中距离统计回写 vec4[1].xy)。
    expect(SDF_GI_PROBE_UPDATE_PARAMS_BYTES).toBe(64);
    expect(SDF_GI_PROBE_UPDATE_ENTRY).toBe("sdfGiProbeUpdateMain");
    expect(SDF_GI_PROBE_RECORD_VEC4_STRIDE).toBe(6);
    expect(SDF_GI_PROBE_UPDATE_BOUNCE_ENERGY_LIMIT).toBe(2.01);
    // 与 CPU 权威域的语义互钉(更新公式同一族;α 缺省同值):
    expect(DEEP_GI_PROBE_TEMPORAL_ALPHA).toBe(0.1);
  });

  it.runIf(Boolean(NAGA))("passes Naga WGSL parsing and semantic validation", () => {
    const result = spawnSync(NAGA!,
      ["--stdin-file-path", "sdfGiProbeUpdate.wgsl", "--input-kind", "wgsl"], {
      input: sharedWgsl, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });

  it("CPU authority: embedded probes pass through, F5 words untouched, alpha blends", () => {
    const directions = [[0, 1, 0], [0, -1, 0], [1, 0, 0]] as const;
    const positions = [[0, 0, 0], [0, 0, 0]] as const;
    const visibility = new Float32Array(6);
    // 探针 0:全开(1);探针 1:埋入(validity 0)。
    visibility.fill(1, 0, 3);
    const previous = [
      { irradiance: [0, 0, 0] as [number, number, number], validity: 1,
        meanDistance: 10, distanceVariance: 1 },
      { irradiance: [9, 9, 9] as [number, number, number], validity: 0,
        meanDistance: 10, distanceVariance: 1,
        directionalVisibilitySh: { r: [1, 0, 0, 0], g: [0, 1, 0, 0], b: [0, 0, 1, 0] } },
    ];
    const result = updateProbeShWithSdfGi({
      previous, positions: positions as unknown as [number, number, number][],
      directions: directions as unknown as [number, number, number][],
      visibilities: visibility,
      directionSkyRadiance: [[1, 0.5, 0.25], [1, 0.5, 0.25], [1, 0.5, 0.25]],
      alpha: 0.1,
    });
    // 探针 0:target = E,首帧 α 混合 → irradiance = 0.1·E;occlusionFloor = c0 = 1。
    expect(result.records[0]!.irradiance[0]).toBeCloseTo(0.1, 6);
    expect(result.records[0]!.occlusionFloor).toBe(1);
    // 探针 1(埋入):整行原样透传,F5 words[12..23] 不动(泄露哨兵)。
    expect(result.records[1]!.irradiance).toEqual([9, 9, 9]);
    expect(result.records[1]!.directionalVisibilitySh).toBeDefined();
    expect(result.skyVisibilitySh[1]).toBeUndefined();
  });
});
