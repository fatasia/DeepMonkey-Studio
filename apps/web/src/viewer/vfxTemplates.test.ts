import { describe, expect, it } from "vitest";
import type { SceneVfxEffectState } from "@bim-studio/contracts";
import { VFX_TEMPLATES, VFX_TEMPLATE_MAP, isVfxTemplateId } from "./vfxTemplates";

const HEX = /^#[0-9a-f]{6}$/i;

/** 模板是场景合同的入口数据:任何一处不完整都会变成坏场景或坏 UI,这里强制闭环。 */
describe("vfx templates", () => {
  it("exposes the eight digital-twin templates with unique ids", () => {
    expect(VFX_TEMPLATES.map((template) => template.id)).toEqual([
      "exhaust-steam", "leak-drip", "sparks", "alarm-ring", "dust", "airflow", "smoke-leak", "spray-mist",
    ]);
    expect(new Set(VFX_TEMPLATES.map((template) => template.id)).size).toBe(VFX_TEMPLATES.length);
  });

  it.each(VFX_TEMPLATES.map((template) => [template.id, template.defaults] as const))(
    "ships complete, in-range defaults for %s",
    (id, defaults: SceneVfxEffectState) => {
      expect(defaults.template).toBe(id);
      expect(defaults.enabled).toBe(true);
      expect(HEX.test(defaults.color)).toBe(true);
      expect(defaults.intensity).toBeGreaterThanOrEqual(0);
      expect(defaults.intensity).toBeLessThanOrEqual(5);
      expect(defaults.rate).toBeGreaterThanOrEqual(0.25);
      expect(defaults.rate).toBeLessThanOrEqual(2);
      expect(defaults.range).toBeGreaterThanOrEqual(0.1);
      expect(defaults.range).toBeLessThanOrEqual(50);
      expect(defaults.lifetime).toBeGreaterThanOrEqual(0.2);
      expect(defaults.lifetime).toBeLessThanOrEqual(8);
      expect(defaults.maxParticles).toBeGreaterThanOrEqual(16);
      expect(defaults.maxParticles).toBeLessThanOrEqual(512);
      expect(["additive", "alpha"]).toContain(defaults.blend);
    },
  );

  it.each(VFX_TEMPLATES.map((template) => [template.id, template.defaults.curves] as const))(
    "defines all three lifecycle curves for %s",
    (_id, curves) => {
      for (const channel of ["size", "alpha", "color"] as const) {
        const keys = curves?.[channel] ?? [];
        expect(keys.length).toBeGreaterThanOrEqual(2);
        for (let index = 0; index < keys.length; index += 1) {
          expect(keys[index]!.time).toBeGreaterThanOrEqual(0);
          expect(keys[index]!.time).toBeLessThanOrEqual(1);
          expect(Number.isFinite(keys[index]!.value)).toBe(true);
          if (index > 0) expect(keys[index]!.time).toBeGreaterThan(keys[index - 1]!.time);
        }
      }
    },
  );

  it("keeps template lookup, guard and labels aligned", () => {
    expect(Object.keys(VFX_TEMPLATE_MAP).length).toBe(VFX_TEMPLATES.length);
    expect(isVfxTemplateId("alarm-ring")).toBe(true);
    expect(isVfxTemplateId("firework")).toBe(false);
    for (const template of VFX_TEMPLATES) {
      expect(template.label[0].length).toBeGreaterThan(0);
      expect(template.label[1].length).toBeGreaterThan(0);
      expect(template.hint[0].length).toBeGreaterThan(0);
      expect(template.rangeLabel[0].length).toBeGreaterThan(0);
      expect(template.pointScale).toBeGreaterThan(0);
      expect(["rise", "fall", "burst", "ring", "drift", "flow"]).toContain(template.motion);
    }
  });
});
