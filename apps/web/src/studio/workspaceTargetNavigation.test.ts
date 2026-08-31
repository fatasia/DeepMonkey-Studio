import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { findScriptTargetLocation, focusViewerTargetWhenReady } from "./workspaceTargetNavigation";

describe("workspace target navigation", () => {
  it("resolves component pages and object scenes from one application document", () => {
    const application = migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
    const page = application.pages[0]!;
    const scene = application.scenes[0]!;
    const node = page.nodes[0]!;

    expect(findScriptTargetLocation(application, { id: node.id, name: "组件", kind: "component", context: page.name })).toEqual({ kind: "component", pageId: page.id });
    expect(findScriptTargetLocation(application, { id: "selected-bim-component", name: "构件", kind: "object", context: scene.name }, scene.id)).toEqual({ kind: "object", sceneId: scene.id });
  });

  it("waits for a target that becomes available during scene streaming", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const result = focusViewerTargetWhenReady(() => ++calls >= 3, { attempts: 4, intervalMs: 10 });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(true);
    expect(calls).toBe(3);
    vi.useRealTimers();
  });
});
