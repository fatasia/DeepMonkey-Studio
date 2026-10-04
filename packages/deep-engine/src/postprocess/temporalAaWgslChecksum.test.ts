// AA-M2 后续切片:时域 AA WGSL 单源门禁(形态照抄 megaLightsRisWgslChecksum.test.ts):
// 1) 生成镜像不陈旧 + 与真源逐字节对拍 + sha256 夹具;
// 2) GHOST_GUARD 决策层与 temporalReprojection.ts 派生函数逐字互钉(策略常量单一来源,
//    字面 0.25/0.05/0.1 由 GHOST_GUARD_REPROJECTION_POLICY 模板化,漂移即门禁失败);
// 3) 编译期开关默认 0 = 关,基线分支逐字保留历史生产语句(关闭输出与旧 WGSL 逐位一致的
//    文本级证明;真机 GPU 逐字节对拍见 scripts/t07TemporalGhostGuardWiringProbe.mts);
// 4) 决策层只在可信历史分支内 —— camera-cut/resize/revision-gap 宿主失效门(生产 pass
//    侧 historyUsed=false,sizeHistory.z=0 整支跳过)与 temporalValidity.ts 独立门不受影响。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import source from "../../wgsl/temporalAa.wgsl?raw";
import pinned from "../../wgsl/temporalAa.wgsl.sha256?raw";
import { TEMPORAL_AA_WGSL, TEMPORAL_AA_WORKGROUP_SIZE } from "./temporalAaWgsl.js";
import { GHOST_GUARD_REPROJECTION_POLICY, TEMPORAL_GHOST_GUARD_CONST_OFF, TEMPORAL_GHOST_GUARD_CONST_ON,
  deriveTemporalGhostGuardWgsl, enableTemporalGhostGuardWgsl } from "./temporalReprojection.js";

const [checksum, byteLength] = pinned.trim().split(/\s+/);
const policy = GHOST_GUARD_REPROJECTION_POLICY;

describe("temporal AA WGSL single-source gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file and pinned by checksum", () => {
    expect(TEMPORAL_AA_WGSL).toBe(source);
    const bytes = new TextEncoder().encode(source);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
    expect(TEMPORAL_AA_WORKGROUP_SIZE).toBe(8);
    expect(TEMPORAL_AA_WGSL).toContain("@workgroup_size(8, 8)");
  });

  it("defaults the compile-time ghost-guard switch off and keeps the legacy statement verbatim", () => {
    expect(TEMPORAL_AA_WGSL).toContain(TEMPORAL_GHOST_GUARD_CONST_OFF);
    expect(TEMPORAL_AA_WGSL).not.toContain(TEMPORAL_GHOST_GUARD_CONST_ON);
    // 关闭路径逐字保留历史生产基线(输出逐位一致的文本级锁定;GPU 逐字节由 T07 探针证明)。
    expect(TEMPORAL_AA_WGSL).toContain("resolved = mix(color.rgb, clampedHistory, temporalParams.tuning.x * (1.0 - reactive));");
    expect(TEMPORAL_AA_WGSL).toContain("let reactive = clamp(textureLoad(reactiveMask, coordinate, 0).x, 0.0, 1.0);");
  });

  it("embeds the policy-derived decision fragment verbatim (single source with the T07 probe)", () => {
    expect(TEMPORAL_AA_WGSL).toContain(deriveTemporalGhostGuardWgsl("coordinate", "size",
      "            var feedback = temporalParams.tuning.x * (1.0 - reactive);"));
    // 策略字面常量与策略对象互钉(单一来源;改策略必须同步重生成 .wgsl + 镜像 + sha256)。
    expect(TEMPORAL_AA_WGSL).toContain(`if (acceptedRatio < ${policy.fallbackAcceptedRatio}) {`);
    expect(TEMPORAL_AA_WGSL).toContain(`if (historyError > ${policy.maxHistoryError}) { feedback = feedback * ${policy.decayFactor}; }`);
    // 三机制关键行:disocclusion = 3x3 当前色 box;内容变化 = clamp 残差 historyError;depth 拒绝仍在 sampleHistory。
    expect(TEMPORAL_AA_WGSL).toContain("boxMean = boxMean + textureLoad(currentColor, neighbor, 0).rgb / 9.0;");
    expect(TEMPORAL_AA_WGSL).toContain("let historyError = dot(abs(clampedHistory - color.rgb), vec3f(1.0)) / 3.0;");
    expect(TEMPORAL_AA_WGSL).toContain("abs(historicalDepth - depth) <= threshold");
  });

  it("flips the switch by exactly one character and fail-fasts on drift or double apply", () => {
    expect(TEMPORAL_GHOST_GUARD_CONST_ON.length).toBe(TEMPORAL_GHOST_GUARD_CONST_OFF.length);
    const enabled = enableTemporalGhostGuardWgsl(TEMPORAL_AA_WGSL);
    expect(enabled.length).toBe(TEMPORAL_AA_WGSL.length);
    expect(enabled).toContain(TEMPORAL_GHOST_GUARD_CONST_ON);
    expect(enabled).not.toContain(TEMPORAL_GHOST_GUARD_CONST_OFF);
    expect(() => enableTemporalGhostGuardWgsl(enabled)).toThrow("drifted");
    expect(() => enableTemporalGhostGuardWgsl("const DEEP_TEMPORAL_GHOST_GUARD: u32 = 2u;")).toThrow("drifted");
  });

  it("keeps the decision layer inside the trusted-history branch (invalidation gates untouched)", () => {
    // 失效帧(sizeHistory.z=0:camera-cut/resize/revision-gap/首帧,宿主 fail-closed)
    // 整支跳过时域项,决策层只活在可信历史路径内;temporalValidity.ts 独立门在本文件之外。
    const gate = TEMPORAL_AA_WGSL.indexOf("if (temporalParams.sizeHistory.z == 1u && depth > 0.0)");
    const guardFragment = TEMPORAL_AA_WGSL.indexOf("let acceptedRatio");
    const legacyMix = TEMPORAL_AA_WGSL.indexOf("resolved = mix(color.rgb, clampedHistory, temporalParams.tuning.x * (1.0 - reactive));");
    expect(gate).toBeGreaterThan(-1);
    expect(legacyMix).toBeGreaterThan(gate);
    expect(guardFragment).toBeGreaterThan(gate);
    // 深度拒绝判据(threshold = max(绝对, 相对))原样保留,box fallback 只在其后分流。
    expect(TEMPORAL_AA_WGSL).toContain("let threshold = max(temporalParams.tuning.y, depth * temporalParams.tuning.z);");
  });
});
