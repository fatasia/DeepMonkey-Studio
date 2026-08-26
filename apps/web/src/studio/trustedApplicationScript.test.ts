import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type InteractionFlow, type SceneSnapshot } from "@bim-studio/contracts";
import { runTrustedApplicationScript } from "./trustedApplicationScript";

describe("runTrustedApplicationScript", () => {
  it("exposes one application API to widget scripts and emits typed actions", async () => {
    const application = migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
    const widgetId = application.pages[0]!.nodes[0]!.id;
    const flow: InteractionFlow = {
      id: "flow:script",
      name: "默认事件",
      source: { kind: "widget", id: widgetId },
      trigger: "click",
      enabled: true,
      actions: [],
      legacyScript: {
        runtime: "legacy-trusted-main-thread",
        script: {
          id: "script:flow",
          name: "默认事件",
          target: { kind: "widget", widgetId },
          trigger: "click",
          enabled: true,
          code: "studio.setData('temperature', 28); studio.updateComponent(ctx.source.id, { visible: false }); studio.action({ type: 'message', message: String(studio.components().length) });"
        }
      }
    };
    const emitAction = vi.fn();
    const setData = vi.fn();
    const updateComponent = vi.fn();

    await runTrustedApplicationScript({ application, flow, source: flow.source, trigger: "click", variables: {}, emitAction, setData, updateComponent });

    expect(setData).toHaveBeenCalledWith("temperature", 28);
    expect(updateComponent).toHaveBeenCalledWith(widgetId, { visible: false });
    expect(emitAction).toHaveBeenCalledWith(expect.objectContaining({ type: "message", enabled: true }));
  });
});
