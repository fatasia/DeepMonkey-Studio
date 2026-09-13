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
});
