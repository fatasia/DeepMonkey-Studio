import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_LIGHTING,
  DEFAULT_POST_PROCESSING,
} from "../appDefaults";
import { DEFAULT_SCENE_COORDINATES } from "../viewer/sceneCoordinates";
import { SceneEnvironmentPanel } from "./SceneEnvironmentPanel";

describe("scene environment accessibility", () => {
  it("names every icon-only environment and lighting action", () => {
    const html = renderToStaticMarkup(
      <SceneEnvironmentPanel
        locale="zh-CN"
        rendererBackend="webgpu"
        coordinates={DEFAULT_SCENE_COORDINATES}
        weather="sunny"
        environment={DEFAULT_ENVIRONMENT}
        lighting={DEFAULT_LIGHTING}
        postProcessing={DEFAULT_POST_PROCESSING}
        selectedLightId="sun-default"
        onCoordinatesChange={vi.fn()}
        onWeatherChange={vi.fn()}
        onEnvironmentChange={vi.fn()}
        onLightingChange={vi.fn()}
        onPostProcessingChange={vi.fn()}
        onChooseEnvironmentMap={vi.fn()}
        onSelectLight={vi.fn()}
        onAddLight={vi.fn()}
        onUpdateLight={vi.fn()}
        onRemoveLight={vi.fn()}
      />,
    );

    for (const label of ["晴天", "阴天", "下雨", "下雪", "雾天", "暴雨", "关闭全局灯光", "删除光源"]) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
    }
  });
});
