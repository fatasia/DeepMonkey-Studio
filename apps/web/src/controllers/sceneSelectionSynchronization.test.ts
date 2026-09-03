import { describe, expect, it } from "vitest";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { synchronizeSelectionFromOutliner, synchronizeSelectionFromViewport } from "./sceneSelectionSynchronization";

describe("三维场景选择同步", () => {
  it("replaces an outliner multi-selection when the viewport selects another object", () => {
    let selectedModel: LoadedSceneModel | undefined;
    let selectedIds = new Set(["pump-a", "pump-b"]);
    let selectedSpace = true;
    let renderRequests = 0;
    const pumpC = { id: "pump-c" } as LoadedSceneModel;

    synchronizeSelectionFromViewport(pumpC, {
      setSelectedModel: (model) => { selectedModel = model; },
      replaceObjectSelection: (ids) => { selectedIds = ids; },
      clearSelectedSpace: () => { selectedSpace = false; },
      requestRender: () => { renderRequests += 1; },
    });

    expect(selectedModel).toBe(pumpC);
    expect([...selectedIds]).toEqual(["pump-c"]);
    expect(selectedSpace).toBe(false);
    expect(renderRequests).toBe(1);
  });

  it("clears the inspector and outliner together when the viewport background is clicked", () => {
    let selectedModel = { id: "pump-a" } as LoadedSceneModel | undefined;
    let selectedIds = new Set(["pump-a", "pump-b"]);

    synchronizeSelectionFromViewport(undefined, {
      setSelectedModel: (model) => { selectedModel = model; },
      replaceObjectSelection: (ids) => { selectedIds = ids; },
      clearSelectedSpace: () => undefined,
      requestRender: () => undefined,
    });

    expect(selectedModel).toBeUndefined();
    expect([...selectedIds]).toEqual([]);
  });

  it("keeps the complete Ctrl selection after the viewer reports its primary object", () => {
    let selectedIds = new Set<string>();

    const ids = synchronizeSelectionFromOutliner(
      ["pump-a", "missing", "pump-b", "pump-a"],
      new Set(["pump-a", "pump-b"]),
      {
        // ViewerEngine.select synchronously emits a single-selection callback.
        selectPrimaryInViewer: (id) => { selectedIds = new Set(id ? [id] : []); },
        replaceObjectSelection: (next) => { selectedIds = next; },
      },
    );

    expect(ids).toEqual(["pump-a", "pump-b"]);
    expect([...selectedIds]).toEqual(["pump-a", "pump-b"]);
  });
});
