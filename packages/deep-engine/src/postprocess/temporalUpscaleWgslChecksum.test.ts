// AA-M2 后续切片:F4 时域上采样 WGSL 单源门禁(形态照抄 temporalAaWgslChecksum.test.ts)。
// 差异点:GHOST_GUARD 决策层 box 邻域与钳制窗同取内部 texel 网格(center/sizeInternal,
// 最近邻,与 motion/reactive 读点一致);reactive 门(flags.y)在 decay 乘子之前生效,
// 关闭路径逐字保留 flags.y 降权的历史生产语句。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import source from "../../wgsl/temporalUpscale.wgsl?raw";
import pinned from "../../wgsl/temporalUpscale.wgsl.sha256?raw";
import { TEMPORAL_UPSCALE_WGSL, TEMPORAL_UPSCALE_WORKGROUP_SIZE } from "./temporalUpscaleWgsl.js";
import { GHOST_GUARD_REPROJECTION_POLICY, TEMPORAL_GHOST_GUARD_CONST_OFF, TEMPORAL_GHOST_GUARD_CONST_ON,
  deriveTemporalGhostGuardWgsl, enableTemporalGhostGuardWgsl } from "./temporalReprojection.js";

const [checksum, byteLength] = pinned.trim().split(/\s+/);
const policy = GHOST_GUARD_REPROJECTION_POLICY;

describe("temporal upscale WGSL single-source gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file and pinned by checksum", () => {
    expect(TEMPORAL_UPSCALE_WGSL).toBe(source);
    const bytes = new TextEncoder().encode(source);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
    expect(TEMPORAL_UPSCALE_WORKGROUP_SIZE).toBe(8);
    expect(TEMPORAL_UPSCALE_WGSL).toContain("@workgroup_size(8, 8)");
  });

  it("defaults the compile-time ghost-guard switch off and keeps the legacy statement verbatim", () => {
    expect(TEMPORAL_UPSCALE_WGSL).toContain(TEMPORAL_GHOST_GUARD_CONST_OFF);
    expect(TEMPORAL_UPSCALE_WGSL).not.toContain(TEMPORAL_GHOST_GUARD_CONST_ON);
    // 关闭路径逐字保留历史生产基线(flags.y reactive 门 + blend 混合)。
    expect(TEMPORAL_UPSCALE_WGSL).toContain("var blend = upscaleParams.tuning.x;");
    expect(TEMPORAL_UPSCALE_WGSL).toContain("blend = blend * (1.0 - reactive);");
    expect(TEMPORAL_UPSCALE_WGSL).toContain("resolved = mix(color.rgb, clampedHistory, blend);");
  });

  it("embeds the policy-derived decision fragment verbatim (internal-texel box, reactive before decay)", () => {
    expect(TEMPORAL_UPSCALE_WGSL).toContain(deriveTemporalGhostGuardWgsl("center", "sizeInternal",
      `            var feedback = upscaleParams.tuning.x;
            if (upscaleParams.flags.y == 1u) {
              let reactive = clamp(textureLoad(reactiveMask, center, 0).x, 0.0, 1.0);
              feedback = feedback * (1.0 - reactive);
            }`));
    expect(TEMPORAL_UPSCALE_WGSL).toContain(`if (acceptedRatio < ${policy.fallbackAcceptedRatio}) {`);
    expect(TEMPORAL_UPSCALE_WGSL).toContain(`if (historyError > ${policy.maxHistoryError}) { feedback = feedback * ${policy.decayFactor}; }`);
    // box 邻域与钳制窗同取内部 texel 网格(与 motion/reactive 最近邻读点一致)。
    expect(TEMPORAL_UPSCALE_WGSL).toContain("let neighbor = clamp(center + vec2<i32>(ox, oy), vec2<i32>(0), vec2<i32>(sizeInternal) - 1);");
    // 次序锁:feedback 先吃 (1 - reactive),再吃 decay 乘子(T07 注入体先例)。
    const reactiveAt = TEMPORAL_UPSCALE_WGSL.indexOf("feedback = feedback * (1.0 - reactive);", TEMPORAL_UPSCALE_WGSL.indexOf("let acceptedRatio"));
    const decayAt = TEMPORAL_UPSCALE_WGSL.indexOf(`feedback = feedback * ${policy.decayFactor};`, reactiveAt);
    expect(reactiveAt).toBeGreaterThan(-1);
    expect(decayAt).toBeGreaterThan(reactiveAt);
  });

  it("flips the switch by exactly one character and fail-fasts on drift or double apply", () => {
    const enabled = enableTemporalGhostGuardWgsl(TEMPORAL_UPSCALE_WGSL);
    expect(enabled.length).toBe(TEMPORAL_UPSCALE_WGSL.length);
    expect(enabled).toContain(TEMPORAL_GHOST_GUARD_CONST_ON);
    expect(enabled).not.toContain(TEMPORAL_GHOST_GUARD_CONST_OFF);
    expect(() => enableTemporalGhostGuardWgsl(enabled)).toThrow("drifted");
  });

  it("keeps the decision layer inside the trusted-history branch (fail-closed gates untouched)", () => {
    // 历史失效(first-frame/resize/camera-cut/revision-gap)时 flags.x=0,时域项整支跳过,
    // 输出退化为纯 Catmull-Rom(fail-closed);决策层只活在可信历史路径内。
    const gate = TEMPORAL_UPSCALE_WGSL.indexOf("if (upscaleParams.flags.x == 1u && depth > 0.0)");
    const guardFragment = TEMPORAL_UPSCALE_WGSL.indexOf("let acceptedRatio");
    const legacyBlend = TEMPORAL_UPSCALE_WGSL.indexOf("resolved = mix(color.rgb, clampedHistory, blend);");
    expect(gate).toBeGreaterThan(-1);
    expect(legacyBlend).toBeGreaterThan(gate);
    expect(guardFragment).toBeGreaterThan(gate);
    expect(TEMPORAL_UPSCALE_WGSL).toContain("let threshold = max(upscaleParams.tuning.y, depth * upscaleParams.tuning.z);");
    // Catmull-Rom 空间核不受决策层影响(失效帧的输出路径)。
    expect(TEMPORAL_UPSCALE_WGSL).toContain("if (a < 1.0) { return 1.5 * a * a * a - 2.5 * a * a + 1.0; }");
  });
});
