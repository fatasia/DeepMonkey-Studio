import { describe, expect, it } from "vitest";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, diffPlanAgainstActual } from "../webgpu/pbrFramePlanExecutor.js";
import { DEFAULT_PBR_RENDERER_FEATURES } from "../webgpu/pbrRendererFeatures.js";
import { describeSdfGiSkyTracePass, describeSdfGiProbeUpdatePass } from "./sdfGiFramePlanDescriptors.js";

/**
 * GI-FIN(2026-10-05)计划对拍合同锁:features.sdfGi 开启时帧图两个 compute pass
 * 经 MAPPED_EXECUTORS 登记 mapped,diffPlanAgainstActual 因此要求实际执行描述 ——
 * GI-FIN 提交漏了 collectActualPbrFramePasses 组装侧,真机探针首帧即抛
 * "Mapped pass sdf-gi-sky-trace has no actual pass description"。本文件把
 * 「mapped ⇔ 有描述 ⇔ 读写面与帧图声明逐字一致」锁死,防同族复发。
 */

// 与真实调用点(pbrRendererFrameSupport captureFeatures)同构:完整 resolved features。
const FEATURES_ON = { ...DEFAULT_PBR_RENDERER_FEATURES, sdfGi: true };
const FEATURES_OFF = { ...DEFAULT_PBR_RENDERER_FEATURES, sdfGi: false };
const SURFACE = { width: 320, height: 240 } as const;

describe("sdfGi frame plan descriptors", () => {
  it("satisfies the plan/actual diff for both sdf-gi passes when sdfGi is on", () => {
    const plan = buildPbrFrameExecutionPlan(SURFACE, { features: FEATURES_ON });
    for (const passId of ["sdf-gi-sky-trace", "sdf-gi-probe-update"]) {
      expect(plan.passes.find(pass => pass.passId === passId)?.mapping)
        .toMatchObject({ status: "mapped" });
    }
    const actual = collectActualPbrFramePasses(FEATURES_ON, false);
    const diff = diffPlanAgainstActual(plan, actual);
    expect(diff.mismatches).toEqual([]);
  });

  it("emits no sdf-gi pass descriptions or plan passes when sdfGi is off", () => {
    const plan = buildPbrFrameExecutionPlan(SURFACE, { features: FEATURES_OFF });
    expect(plan.passOrder.filter(id => id.startsWith("sdf-gi-"))).toEqual([]);
    const actual = collectActualPbrFramePasses(FEATURES_OFF, false);
    expect(actual.map(pass => pass.passId).filter(id => id.startsWith("sdf-gi-"))).toEqual([]);
  });

  it("declares read/write surfaces identical to the frame graph pass declarations", () => {
    const plan = buildPbrFrameExecutionPlan(SURFACE, { features: FEATURES_ON });
    const byId = new Map(plan.passes.map(pass => [pass.passId, pass]));
    const skyTrace = describeSdfGiSkyTracePass();
    expect(skyTrace.reads).toEqual(byId.get("sdf-gi-sky-trace")!.reads);
    expect(skyTrace.writes).toEqual(byId.get("sdf-gi-sky-trace")!.writes);
    expect(skyTrace.kind).toBe("compute");
    expect(skyTrace.gpuPassCount).toBe(1);
    const probeUpdate = describeSdfGiProbeUpdatePass();
    expect(probeUpdate.reads).toEqual(byId.get("sdf-gi-probe-update")!.reads);
    expect(probeUpdate.writes).toEqual(byId.get("sdf-gi-probe-update")!.writes);
    // buffer claim format 走 descriptor 相等口径(合同 format undefined → plannedResources 兜底)。
    expect(skyTrace.claims.map(claim => claim.format)).toEqual(
      ["sdf-gi-field-buffer-v1", "sdf-gi-visibilities-buffer-v1", "sdf-gi-hit-distances-buffer-v1"]);
    expect(probeUpdate.claims.map(claim => claim.format)).toEqual(
      ["sdf-gi-visibilities-buffer-v1", "sdf-gi-hit-distances-buffer-v1", "sdf-gi-records-buffer-v1"]);
  });
});
