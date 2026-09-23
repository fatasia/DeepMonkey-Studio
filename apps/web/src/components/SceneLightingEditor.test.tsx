import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GlobalLightingState, SceneLightState } from "@bim-studio/contracts";
import { SceneLightingEditor } from "./SceneLightingEditor";
const directionLight = {
  id: "sun",
  name: "主方向光",
  type: "directional",
  color: "#ffffff",
  intensity: 2,
  enabled: true,
  castShadow: true,
  position: { x: 4, y: 8, z: 4 },
  target: { x: 0, y: 0, z: 0 },
} as SceneLightState;

const spotLight = { ...directionLight, id: "spot", name: "工位聚光灯", type: "spot",
  target: { x: 0, y: 0, z: 0 }, distance: 12, decay: 2, angle: Math.PI / 4, penumbra: .5 } as SceneLightState;

function render(selectedLightId: string) {
  return renderToStaticMarkup(<SceneLightingEditor
    locale="zh-CN"
    lighting={{ enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: true, lights: [directionLight] } as GlobalLightingState}
    selectedLightId={selectedLightId}
    onLightingChange={vi.fn()}
    onSelectLight={vi.fn()}
    onAddLight={vi.fn()}
    onUpdateLight={vi.fn()}
    onRemoveLight={vi.fn()}
  />);
}

function renderIes() {
  return renderToStaticMarkup(<SceneLightingEditor locale="zh-CN"
    lighting={{ enabled: true, intensity: 1, lights: [spotLight], lightProfiles: [{ profileId: "ies-factory",
      format: "LM-63-2002", verticalAngles: [0, 45, 90], candela: [[1000, 500, 100]], horizontalSymmetry: 1, totalLumens: 1234.5 }] }}
    selectedLightId="spot" onLightingChange={vi.fn()} onSelectLight={vi.fn()} onAddLight={vi.fn()}
    onUpdateLight={vi.fn()} onRemoveLight={vi.fn()} />);
}

describe("SceneLightingEditor", () => {
  it("does not visually select the first light until the user selects it", () => {
    const html = render("");
    expect(html).toContain("主方向光");
    expect(html).not.toContain('class="active"><i');
    expect(html).not.toContain('value="主方向光"');
  });

  it("opens the explicit light selection for editing", () => {
    const html = render("sun");
    expect(html).toContain('class="active"><i');
    expect(html).toContain('value="主方向光"');
  });
  it("exposes IES import and saved profile selection only for a spot light", () => {
    const html = renderIes();
    expect(html).toContain("导入光域网");
    expect(html).toContain("ies-factory");
    expect(html).toContain('accept=".ies,text/plain"');
    expect(render("sun")).not.toContain("导入光域网");
  });
  it("exposes bounded Deep PCSS softness only for a shadow-casting spot", () => {
    expect(renderIes()).toContain("阴影柔化");
    expect(renderIes()).toContain("Deep WebGPU PCSS");
    expect(render("sun")).not.toContain("阴影柔化");
  });
  it("renders the F3 probe-grid bake block only when the parent wires it in", () => {
    const baked = renderWithProbeBake({ kind: "done", probeCount: 8, coveredCount: 8, coverage: 1 });
    expect(baked).toContain("烘焙探针网格");
    expect(baked).toContain("探针 8 · 覆盖 8/8（100%）");
    // 未接线时不得出现烘焙区块（管理中心等其他使用方不受影响）。
    expect(render("sun")).not.toContain("烘焙探针网格");
  });
});

function renderWithProbeBake(state: { kind: "done"; probeCount: number; coveredCount: number; coverage: number }) {
  return renderToStaticMarkup(<SceneLightingEditor
    locale="zh-CN"
    lighting={{ enabled: true, intensity: 1, shadowsEnabled: true, reflectionsEnabled: true, lights: [directionLight] } as GlobalLightingState}
    selectedLightId="sun"
    onLightingChange={vi.fn()}
    onSelectLight={vi.fn()}
    onAddLight={vi.fn()}
    onUpdateLight={vi.fn()}
    onRemoveLight={vi.fn()}
    probeBakeState={state}
    onBakeProbeGrid={vi.fn()}
  />);
}
