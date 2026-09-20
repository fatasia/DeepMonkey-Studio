import { describe, expect, it } from "vitest";
import type { ApplicationDocument } from "@bim-studio/contracts";
import { buildEditorSceneDraftSnapshot } from "./editorSceneDraftSnapshot";

function document(overrides: {
  objects?: number; selectionSets?: number; spatialNodes?: number;
} = {}): ApplicationDocument {
  const models = Array.from({ length: overrides.objects ?? 2 }, (_, index) => ({
    modelId: `model-${index}`, name: `Model ${index}`, visible: index % 2 === 0, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    ...(index === 0 ? { layers: [{ nodeId: "shell", name: "Shell", visible: false }] } : {}),
  }));
  return {
    metadata: { id: "app-1", projectId: "project-1", name: "Plant", revision: 3, createdAt: "now", updatedAt: "now" },
    data: { variables: [], functions: [], sources: [] },
    pages: [], topologies: [],
    scenes: [{
      id: "scene-1", name: "Line", models, primitives: [],
      selectionSets: Array.from({ length: overrides.selectionSets ?? 1 }, (_, index) => ({
        id: `set-${index}`, name: `Set ${index}`, objectIds: ["model-0"], kind: "group",
      })),
    }],
    spatialNavigation: {
      rootNodeIds: ["plant"], cacheLimit: 2,
      nodes: Array.from({ length: overrides.spatialNodes ?? 1 }, (_, index) => ({
        id: `node-${index}`, name: `Node ${index}`, kind: "plant", sceneId: "scene-1", loadPolicy: "focus",
      })),
    },
  } as unknown as ApplicationDocument;
}

describe("editor scene draft snapshot", () => {
  it("mirrors objects, layers, selection sets, and spatial relations for the active scene", () => {
    const snapshot = buildEditorSceneDraftSnapshot(document(), "scene-1", 11);
    expect(snapshot).toMatchObject({ sceneId: "scene-1", revision: 11 });
    expect(snapshot!.objects).toHaveLength(2);
    expect(snapshot!.objects[0]).toMatchObject({
      objectId: "model-0", kind: "model", visible: true, locked: false,
      layers: [{ id: "shell", name: "Shell", visible: false }],
    });
    expect(snapshot!.selectionSets).toEqual([expect.objectContaining({ id: "set-0", objectIds: ["model-0"] })]);
    expect(snapshot!.spatialRelations).toEqual([expect.objectContaining({ id: "node-0", sceneId: "scene-1" })]);
  });

  it("returns undefined for a foreign scene instead of guessing", () => {
    expect(buildEditorSceneDraftSnapshot(document(), "scene-404", 11)).toBeUndefined();
  });

  it("drops the whole mirror when any section exceeds its bound (all-or-nothing)", () => {
    expect(buildEditorSceneDraftSnapshot(document({ selectionSets: 201 }), "scene-1", 11)).toBeUndefined();
    expect(buildEditorSceneDraftSnapshot(document({ spatialNodes: 1001 }), "scene-1", 11)).toBeUndefined();
    expect(buildEditorSceneDraftSnapshot(document({ objects: 2001 }), "scene-1", 11)).toBeUndefined();
    expect(buildEditorSceneDraftSnapshot(document({ selectionSets: 200, spatialNodes: 1000, objects: 2000 }), "scene-1", 11))
      .toMatchObject({ sceneId: "scene-1" });
  });
});
