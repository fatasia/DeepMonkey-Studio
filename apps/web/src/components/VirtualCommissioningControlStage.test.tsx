import type { SceneSnapshot } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createVirtualDebugBinding } from "./virtualCommissioningDraft";
import { virtualDebugObjectOptions } from "./virtualCommissioningModel";
import { VirtualCommissioningControlStage } from "./VirtualCommissioningControlStage";

describe("VirtualCommissioningControlStage", () => {
  it("runs the complete preset as the single visible primary action", () => {
    const scene = sceneFixture();
    const html = renderToStaticMarkup(<VirtualCommissioningControlStage
      scene={scene}
      objects={virtualDebugObjectOptions(scene)}
      bindings={[createVirtualDebugBinding(1, "alarm", scene.id, "device-1", "primitive")]}
      durationMs={1_000} tickMs={50} speedSetpoint={1_200}
      faultEnabled faultAtMs={500} resetEnabled resetAtMs={800}
      acceptanceAtMs={800} acceptanceSignal="alarm" acceptanceText="false"
      busy={false}
      onRunScenario={vi.fn()} onRunSuite={vi.fn()}
      onDurationChange={vi.fn()} onTickChange={vi.fn()} onSpeedChange={vi.fn()}
      onFaultEnabledChange={vi.fn()} onFaultAtChange={vi.fn()}
      onResetEnabledChange={vi.fn()} onResetAtChange={vi.fn()}
      onAcceptanceAtChange={vi.fn()} onAcceptanceSignalChange={vi.fn()} onAcceptanceTextChange={vi.fn()}
      onAddBinding={vi.fn()} onBindingChange={vi.fn()} onBindingRemove={vi.fn()}
    />);

    expect(html).toContain("直接运行预设");
    expect(html).toContain("验证控制逻辑");
    expect(html).not.toContain("运行完整预设");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html.indexOf("验证控制逻辑")).toBeLessThan(html.indexOf("运行当前用例"));
  });
});

function sceneFixture(): SceneSnapshot {
  const transform = {
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  };
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "装配工位",
    camera: { position: { x: 3, y: 3, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [{ modelId: "device-1", name: "输送机", kind: "box", color: "#5a8f91", visible: true, opacity: 1, transform }],
    measurements: [],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}
