import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FIRE_EFFECT } from "../viewer/modelEffectState";
import { planSceneFireBudget } from "../viewer/modelFireParticles";
import { ModelEffectsEditor } from "./ModelEffectsEditor";

const effects = (fire: Partial<typeof DEFAULT_FIRE_EFFECT> = {}) => ({
  outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false,
  color: "#e0b755", intensity: 1, fire: { ...DEFAULT_FIRE_EFFECT, enabled: true, ...fire },
});

function render(fire: Partial<typeof DEFAULT_FIRE_EFFECT>, budget = planSceneFireBudget([{ id: "pump", requested: 80 }])) {
  return renderToStaticMarkup(
    <ModelEffectsEditor
      locale="zh-CN"
      rendererBackend="webgl"
      disabled={false}
      effects={effects(fire)}
      onChange={vi.fn()}
      particleBudget={budget}
      particleEmitterId="pump"
    />,
  );
}

describe("ModelEffectsEditor fire particle controls", () => {
  it("exposes lifetime curves, blend mode and the budget read-out", () => {
    const html = render({});
    for (const text of ["尺寸", "不透明度", "热度色", "生命周期曲线", "粒子上限", "叠加", "透明·排序", "场景预算", "本发射器"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('data-degraded="false"');
    expect(html).not.toContain("fire-budget-warning");
    expect((html.match(/role="slider"/g) ?? []).length).toBeGreaterThanOrEqual(9);
    expect(html).toContain("80 / 80");
  });

  it("shows a visible degradation warning when the scene budget is exceeded", () => {
    const budget = planSceneFireBudget(Array.from({ length: 10 }, (_, i) => ({ id: i === 0 ? "pump" : `m${i}`, requested: 160 })));
    const html = render({ density: 2 }, budget);
    expect(html).toContain('data-degraded="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("fire-budget-warning");
    expect(html).toContain("超出场景粒子预算");
    expect(html).toContain("1024 / 1024");
  });

  it("marks the active blend mode and renders nothing for a disabled emitter", () => {
    const alpha = render({ blend: "alpha" });
    expect(alpha).toMatch(/aria-pressed="true"[^>]*title="[^"]*"[^>]*>透明·排序/);
    expect(render({})).toMatch(/aria-pressed="true"[^>]*>叠加/);
    const disabled = render({ enabled: false });
    expect(disabled).not.toContain("fire-curves");
    expect(disabled).not.toContain("fire-budget");
  });
});