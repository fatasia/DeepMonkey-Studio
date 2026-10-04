import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FIRE_EFFECT } from "../viewer/modelEffectState";
import { planSceneFireBudget } from "../viewer/modelFireParticles";
import { planSceneVfxBudget } from "../viewer/modelVfxParticles";
import { VFX_TEMPLATES, VFX_TEMPLATE_MAP } from "../viewer/vfxTemplates";
import { ModelEffectsEditor } from "./ModelEffectsEditor";

const effects = (fire: Partial<typeof DEFAULT_FIRE_EFFECT> = {}) => ({
  outline: false, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false,
  color: "#e0b755", intensity: 1, fire: { ...DEFAULT_FIRE_EFFECT, enabled: true, ...fire },
});

const withVfx = (vfx?: typeof VFX_TEMPLATE_MAP[keyof typeof VFX_TEMPLATE_MAP]["defaults"]) => ({
  ...effects(), ...(vfx ? { vfx } : {}),
});

function render(effectsState: ReturnType<typeof withVfx>, budgets: { fire?: ReturnType<typeof planSceneFireBudget>; vfx?: ReturnType<typeof planSceneVfxBudget> } = {}) {
  return renderToStaticMarkup(
    <ModelEffectsEditor
      locale="zh-CN"
      rendererBackend="webgl"
      disabled={false}
      effects={effectsState}
      onChange={vi.fn()}
      particleBudget={budgets.fire}
      vfxBudget={budgets.vfx}
      particleEmitterId="pump"
    />,
  );
}

describe("ModelEffectsEditor fire particle controls", () => {
  it("exposes lifetime curves, blend mode and the budget read-out", () => {
    const html = render(effects(), { fire: planSceneFireBudget([{ id: "pump", requested: 80 }]) });
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
    const html = render(effects({ density: 2 }), { fire: budget });
    expect(html).toContain('data-degraded="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("fire-budget-warning");
    expect(html).toContain("超出场景粒子预算");
    expect(html).toContain("1024 / 1024");
  });

  it("marks the active blend mode and renders nothing for a disabled emitter", () => {
    const alpha = render(effects({ blend: "alpha" }));
    expect(alpha).toMatch(/aria-pressed="true"[^>]*title="[^"]*"[^>]*>透明·排序/);
    expect(render(effects())).toMatch(/aria-pressed="true"[^>]*>叠加/);
    const disabled = render(effects({ enabled: false }));
    expect(disabled).not.toContain("fire-curves");
    expect(disabled).not.toContain("fire-budget");
  });
});

describe("ModelEffectsEditor vfx template library", () => {
  it("renders all eight template cards with names, hints and swatches", () => {
    const html = render(withVfx());
    expect(html).toContain("VFX 图层");
    expect(html).toContain("vfx-template-grid");
    expect((html.match(/vfx-template-card/g) ?? []).length).toBe(VFX_TEMPLATES.length);
    for (const template of VFX_TEMPLATES) {
      expect(html).toContain(template.label[0]);
      expect(html).toContain(template.hint[0]);
    }
    expect(html).not.toContain("data-testid=\"vfx-fields\"");
  });

  it("exposes the orchestration parameters once a template is attached", () => {
    const html = render(withVfx({ ...VFX_TEMPLATE_MAP["alarm-ring"].defaults }));
    expect(html).toContain('data-qa="vfx-fields"');
    for (const text of ["速率", "扩散半径", "生命周期", "移除 VFX 图层"]) {
      expect(html).toContain(text);
    }
    // 告警环卡片处于选中态。
    expect(html).toContain('class="vfx-template-card active" data-qa="vfx-template-alarm-ring" aria-pressed="true"');
    // VFX 只暴露尺寸/不透明度两条曲线(热度色对非火焰模板语义弱)。
    const fields = html.split('data-qa="vfx-fields"')[1] ?? "";
    const vfxSection = fields.split('fire-effect-editor"')[0] ?? fields;
    expect((vfxSection.match(/fire-curve-head/g) ?? []).length).toBe(2);
  });

  it("shows the independent vfx budget read-out and its degradation warning", () => {
    const budget = planSceneVfxBudget(Array.from({ length: 10 }, (_, i) => ({ id: i === 0 ? "pump" : `v${i}`, requested: 160 })));
    const html = render(withVfx({ ...VFX_TEMPLATE_MAP["exhaust-steam"].defaults }), { vfx: budget });
    expect(html).toContain("超出 VFX 场景粒子预算");
    expect(html).toContain("1024 / 1024");
    expect(html).toContain('data-degraded="true"');
  });
});