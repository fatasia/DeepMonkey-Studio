import { describe, expect, it } from "vitest";
import type { SceneVfxEffectState } from "@bim-studio/contracts";
import { VFX_TEMPLATE_MAP } from "./vfxTemplates";
import type { VfxEffectPatch } from "./modelEffectState";
import { planSceneVfxBudget, resolveVfxCurves, sanitizeVfxCurve, vfxBlendMode, vfxRequestedParticles, withVfxCurve } from "./modelVfxParticles";

const state = (patch: VfxEffectPatch = {}): SceneVfxEffectState => ({
  ...VFX_TEMPLATE_MAP["exhaust-steam"].defaults, ...patch,
}) as SceneVfxEffectState;

describe("vfx particle parameter layer", () => {
  it("scales the requested emitter count by rate and clamps to the author cap", () => {
    expect(vfxRequestedParticles(state({ rate: 1, maxParticles: undefined }))).toBe(80);
    expect(vfxRequestedParticles(state({ rate: 0.25 }))).toBe(20);
    expect(vfxRequestedParticles(state({ rate: 2 }))).toBe(160);
    // 申请被作者上限截断。
    expect(vfxRequestedParticles(state({ rate: 2, maxParticles: 48 }))).toBe(48);
  });

  it("falls back to template curves for missing channels and tolerates invalid frames", () => {
    const resolved = resolveVfxCurves(state({ curves: { alpha: [{ time: 5, value: Number.NaN }] } }));
    expect(resolved.size.length).toBeGreaterThan(0);
    expect(resolved.alpha.length).toBeGreaterThan(0);
    expect(resolved.color.length).toBeGreaterThan(0);
    // 非法帧回退模板默认而不是抛错/空 LUT。
    const templateAlpha = VFX_TEMPLATE_MAP["exhaust-steam"].defaults.curves!.alpha!;
    const sample = resolved.alpha[Math.floor(resolved.alpha.length * templateAlpha[0]!.time)]!;
    expect(Number.isFinite(sample)).toBe(true);
  });

  it("sanitizes curve keyframes: clamps, sorts, dedupes and caps at 16 keys", () => {
    expect(sanitizeVfxCurve([{ time: 1.5, value: -2 }, { time: 0, value: 0.5 }, { time: 0, value: 0.9 }], "alpha"))
      .toEqual([{ time: 0, value: 0.9 }, { time: 1, value: 0 }]);
    expect(sanitizeVfxCurve([{ time: 0, value: 9 }], "size")).toEqual([{ time: 0, value: 4 }]);
    expect(sanitizeVfxCurve(undefined, "size")).toBeUndefined();
    expect(sanitizeVfxCurve(Array.from({ length: 20 }, (_, i) => ({ time: i / 19, value: 1 })), "alpha")?.length).toBe(16);
  });

  it("writes single curves and drops the container when the last custom curve is removed", () => {
    // 无既有自定义曲线时只写入目标通道。
    const withSize = withVfxCurve(state({ curves: undefined }), "size", [{ time: 0, value: 1 }, { time: 1, value: 2 }]);
    expect(withSize?.size).toEqual([{ time: 0, value: 1 }, { time: 1, value: 2 }]);
    expect(withSize?.alpha).toBeUndefined();
    // 其余既有自定义通道保留;最后一个自定义通道移除后容器整个消失。
    const mixed = withVfxCurve(
      { ...state(), curves: { size: [{ time: 0, value: 1 }, { time: 1, value: 2 }], alpha: [{ time: 0, value: 0.5 }, { time: 1, value: 0.5 }] } },
      "alpha",
      undefined,
    );
    expect(mixed?.alpha).toBeUndefined();
    expect(mixed?.size).toEqual([{ time: 0, value: 1 }, { time: 1, value: 2 }]);
    expect(withVfxCurve({ ...state(), curves: { size: [{ time: 0, value: 1 }, { time: 1, value: 2 }] } }, "size", undefined)).toBeUndefined();
  });

  it("plans an independent scene budget with largest-remainder degradation", () => {
    const calm = planSceneVfxBudget([{ id: "vent", requested: 80 }]);
    expect(calm.degraded).toBe(false);
    expect(calm.allocatedTotal).toBe(80);
    const flooded = planSceneVfxBudget(
      Array.from({ length: 12 }, (_, index) => ({ id: `e${index}`, requested: 160 })),
    );
    expect(flooded.sceneBudget).toBe(1024);
    expect(flooded.degraded).toBe(true);
    expect(flooded.allocatedTotal).toBeLessThanOrEqual(1024);
    expect(flooded.emitters.every((emitter) => emitter.allocated < emitter.requested)).toBe(true);
  });

  it("resolves the blend mode from the template when the author has not overridden it", () => {
    expect(vfxBlendMode(state({ template: "sparks", blend: undefined }))).toBe("additive");
    expect(vfxBlendMode(state({ template: "exhaust-steam", blend: undefined }))).toBe("alpha");
    expect(vfxBlendMode(state({ template: "exhaust-steam", blend: "additive" }))).toBe("additive");
  });
});
