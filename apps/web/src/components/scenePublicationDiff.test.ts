import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { summarizeScenePublicationDiff } from "./scenePublicationDiff";

describe("scene publication diff", () => {
  it("ignores lifecycle timestamps and transient editor selection", () => {
    const published = scene();
    const draft = { ...structuredClone(published), updatedAt: "2026-08-27T12:00:00.000Z", publishedAt: "2026-08-27T11:00:00.000Z", selectedLayerId: "layer-2" };

    expect(summarizeScenePublicationDiff(draft, published)).toMatchObject({ hasChanges: false, changedSections: [] });
  });

  it("reports semantic sections and count deltas relative to a publication", () => {
    const published = scene();
    const draft = structuredClone(published);
    draft.models.push(model("model-2"));
    draft.dashboard!.widgets.push(widget("widget-2"));
    draft.dataBindings = [{ id: "binding-1", name: "Temperature", enabled: true, field: "temperature", target: {}, action: "label", refreshSeconds: 5 }];
    draft.camera.position.x = 42;
    draft.publicationMode = "webgpu-preferred";

    const result = summarizeScenePublicationDiff(draft, published);

    expect(result.changedSections).toEqual(["content", "camera", "dashboard", "data", "runtime"]);
    expect(result.metrics.find((metric) => metric.id === "objects")).toMatchObject({ published: 1, draft: 2, delta: 1 });
    expect(result.metrics.find((metric) => metric.id === "widgets")).toMatchObject({ published: 1, draft: 2, delta: 1 });
    expect(result.metrics.find((metric) => metric.id === "bindings")).toMatchObject({ published: 0, draft: 1, delta: 1 });
  });

  it("detects edits even when collection counts stay unchanged", () => {
    const published = scene();
    const draft = structuredClone(published);
    draft.dashboard!.widgets[0] = { ...draft.dashboard!.widgets[0]!, title: "Updated title" };

    const result = summarizeScenePublicationDiff(draft, published);

    expect(result.changedSections).toEqual(["dashboard"]);
    expect(result.metrics.find((metric) => metric.id === "widgets")?.delta).toBe(0);
  });

  it("treats the fast publication profile as a runtime change", () => {
    const published = scene();
    const draft = structuredClone(published);
    draft.publicationPerformance = "fast";

    const result = summarizeScenePublicationDiff(draft, published);

    expect(result.changedSections).toEqual(["runtime"]);
    expect(result.hasChanges).toBe(true);
  });

  it("保持旧发布默认显示工具栏，并识别显式隐藏配置", () => {
    const published = scene();
    const compatibleDraft = { ...structuredClone(published), publicationToolbarVisible: true };
    expect(summarizeScenePublicationDiff(compatibleDraft, published).changedSections).toEqual([]);

    const hiddenToolbarDraft = { ...structuredClone(published), publicationToolbarVisible: false };
    expect(summarizeScenePublicationDiff(hiddenToolbarDraft, published).changedSections).toEqual(["runtime"]);
  });
});

function scene(): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "Factory",
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [model("model-1")],
    primitives: [],
    measurements: [],
    dashboard: { side: "left", width: 320, widgets: [widget("widget-1")] },
    dataBindings: [],
    interactions: [],
    publicationMode: "webgl",
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z"
  };
}

function model(modelId: string): SceneSnapshot["models"][number] {
  return {
    modelId,
    name: modelId,
    visible: true,
    opacity: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    }
  };
}

function widget(id: string): NonNullable<SceneSnapshot["dashboard"]>["widgets"][number] {
  return { id, title: "Output", key: "output", type: "value", unit: "pcs", x: 0, y: 0, w: 4, h: 2 };
}
