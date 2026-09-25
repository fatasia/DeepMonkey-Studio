import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SceneToolDock } from "./SceneToolDock";

describe("SceneToolDock", () => {
  it("keeps orientation controls from overriding the centered scene dock", async () => {
    const cubeStyles = await readFile(new URL("./ViewOrientationCube.css", import.meta.url), "utf8");
    expect(cubeStyles).not.toContain(".scene-tool-dock");
    expect(cubeStyles).toMatch(/@container studio-scene \(max-width:1000px\)[\s\S]*\.cube-actions\s*\{[^}]*top:calc\(100% \+ 24px\);\s*bottom:auto/);
  });

  it("keeps primary actions visible and secondary tools progressively disclosed", () => {
    const onAction = vi.fn();
    const html = renderToStaticMarkup(
      <SceneToolDock
        locale="zh-CN"
        navigationMode="orbit"
        transformMode="translate"
        hasSelection={true}
        hasModelSelection={true}
        selectionScope="model"
        measureEnabled={false}
        annotationEnabled={false}
        clippingEnabled={false}
        explosionActive={false}
        avatarVisible={false}
        environmentOpen={false}
        animationOpen={false}
        behaviorOpen={false}
        cameraOpen={false}
        physicsOpen={false}
        xrOpen={false}
        simulationPanel={undefined}
        infoEnabled={false}
        engineeringOpen={false}
        onFitAll={onAction}
        onSelect={onAction}
        onTransformChange={onAction}
        onSelectionScopeToggle={onAction}
        onMeasurementToggle={onAction}
        onPrimitivePlace={onAction}
        onAnnotationToggle={onAction}
        onClippingToggle={onAction}
        onExplosionToggle={onAction}
        onNavigationChange={onAction}
        onAvatarToggle={onAction}
        onInfoToggle={onAction}
        onEngineeringToggle={onAction}
        onEnvironmentToggle={onAction}
        onAnimationToggle={onAction}
        onBehaviorToggle={onAction}
        onCameraToggle={onAction}
        onPhysicsToggle={onAction}
        onXrToggle={onAction}
        onSimulationPanelChange={onAction}
      />,
    );

    expect(html).toContain('aria-label="选择"');
    expect(html).toContain('aria-label="测量"');
    expect(html).toContain("创建");
    expect(html).toContain("查看与分析");
    expect(html).toContain("仿真与开发");
    // 窄视口隐藏文字 span，按钮仍必须有可访问名称与悬浮提示。
    for (const label of ["创建", "查看与分析", "仿真与开发"]) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
    }
    expect(html).not.toContain("第一人称行走");
    expect(html).not.toContain("剖切模型");
    expect(html).not.toContain("行为脚本");
  });

});
