import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneToolDock } from "./SceneToolDock";

describe("SceneToolDock", () => {
  it("keeps primary actions visible and secondary tools progressively disclosed", () => {
    const onAction = vi.fn();
    const html = renderToStaticMarkup(
      <SceneToolDock
        locale="zh-CN"
        navigationMode="orbit"
        transformMode="translate"
        hasSelection={true}
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
    expect(html).not.toContain("第一人称行走");
    expect(html).not.toContain("剖切模型");
    expect(html).not.toContain("行为脚本");
  });
});
