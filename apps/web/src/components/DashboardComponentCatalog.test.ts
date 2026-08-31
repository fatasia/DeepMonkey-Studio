import {
  assertApplicationDocument,
  migrateSceneSnapshotV1,
  type DashboardDataWidgetConfig,
  type SceneDashboardWidgetType,
  type SceneSnapshot,
} from "@bim-studio/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import pure3dFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { createDefaultDataWidget, DATA_WIDGET_CATEGORIES, DATA_WIDGET_TYPES, DECORATION_ASSETS } from "./dashboardWorkspaceModel";

const functionalPresets = DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category !== "material");
const decorationPresets = DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category === "material");

describe("DashboardComponentCatalog", () => {
  it("meets the commercial functional and decoration coverage gates", () => {
    expect(functionalPresets.length).toBeGreaterThanOrEqual(80);
    expect(decorationPresets.length).toBeGreaterThanOrEqual(60);
    expect(new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.id)).size).toBe(DASHBOARD_COMPONENT_PRESETS.length);

    const requiredCategories = ["indicator", "analysis", "report", "control", "media", "gis", "topology", "industrial", "material"];
    expect(new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.category))).toEqual(new Set(requiredCategories));
  });

  it("covers every 2D runtime type except the dedicated 3D Unity viewport", () => {
    const functionalTypes = new Set(functionalPresets.map((preset) => preset.type));
    const requiredTypes = DATA_WIDGET_TYPES.filter((type) => type !== "decoration" && type !== "unity");
    expect(requiredTypes.every((type) => functionalTypes.has(type))).toBe(true);

    const categorizedTypes = new Set(DATA_WIDGET_CATEGORIES.flatMap((category) => category.types));
    expect(categorizedTypes).toEqual(new Set(DATA_WIDGET_TYPES));
    expect(DECORATION_ASSETS.length).toBeGreaterThanOrEqual(12);
  });

  it("ships purposeful defaults and a stable preview for every preset", () => {
    expect(DASHBOARD_COMPONENT_PRESETS.every((preset) => preset.zh.trim() && preset.descriptionZh.trim())).toBe(true);
    expect(DASHBOARD_COMPONENT_PRESETS.every((preset) => preset.widget.title?.trim())).toBe(true);
    expect(new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.preview.variant)).size).toBe(DASHBOARD_COMPONENT_PRESETS.length);

    for (const preset of DASHBOARD_COMPONENT_PRESETS) {
      const html = renderToStaticMarkup(createElement(DashboardComponentPreview, {
        type: preset.type,
        preview: preset.preview,
        ...(preset.widget.decorationStyle ? { decorationStyle: preset.widget.decorationStyle } : {}),
      }));
      expect(html).toContain(`data-preview-variant="${preset.id}"`);
      expect(html).toContain("dashboard-library-preview-mark");
    }
  });

  it("produces application-valid editable default configurations", () => {
    const application = migrateSceneSnapshotV1(pure3dFixture as SceneSnapshot);
    const page = application.pages[0]!;
    page.nodes = DASHBOARD_COMPONENT_PRESETS.map((preset, index) => ({
      id: `catalog:${preset.id}`,
      name: preset.id,
      kind: "data-widget" as const,
      frame: { x: 0, y: 0, width: preset.frame?.width ?? 420, height: preset.frame?.height ?? 240 },
      zIndex: index + 1,
      widget: fullWidget(preset.type, preset.widget),
    }));

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });
});

function fullWidget(
  type: SceneDashboardWidgetType,
  patch: Partial<DashboardDataWidgetConfig>,
): DashboardDataWidgetConfig {
  return { ...createDefaultDataWidget("zh-CN", type), ...structuredClone(patch) };
}
