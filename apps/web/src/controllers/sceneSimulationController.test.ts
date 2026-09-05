import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot, SimulationEntityState } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import { createSceneSimulationController, mergeSavedSimulationScene } from "./sceneSimulationController";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";

const path: SimulationEntityState = { id: "path", kind: "path", name: "送料路线", targetModelId: "box", speed: 1, loopMode: "once", points: [[0, 0, 0], [3, 0, 0]] };
function harness() {
  let scene = { id: "scene", simulationEntities: [structuredClone(path)] } as SceneSnapshot;
  let revision = 0;
  const history = new SceneAuthoringHistory();
  history.reset(scene);
  const showError = vi.fn();
  const actions = () => createSceneSimulationController({
    activeScene: scene, engine: undefined, showError,
    setActiveScene: (update) => { scene = (typeof update === "function" ? update(scene) : update)!; },
    setRevision: (update) => { revision = typeof update === "function" ? update(revision) : update; },
    recordSceneEdit: (label) => { history.record(scene, label); },
  });
  return { actions, showError, history, scene: () => scene, revision: () => revision, setScene: (value: SceneSnapshot) => { scene = value; } };
}

describe("simulation scene controller", () => {
  it("writes edits and deletion into scene snapshots, records dirty state and supports undo/redo", () => {
    const h = harness();
    h.actions().updateSimulationEntity({ ...path, name: "新路线", speed: 2 });
    expect(h.scene().simulationEntities?.[0]).toMatchObject({ name: "新路线", speed: 2 });
    h.actions().deleteSimulationEntity("path");
    expect(h.scene().simulationEntities).toEqual([]);
    expect(h.history.undo()?.simulationEntities?.[0]).toMatchObject({ speed: 2 });
    expect(h.history.redo()?.simulationEntities).toEqual([]);
    expect(h.revision()).toBe(2);
  });

  it("rejects non-finite values without dirtying the scene and allows existing broken targets to be edited", () => {
    const h = harness();
    h.actions().updateSimulationEntity({ ...path, speed: Infinity });
    expect(h.showError).toHaveBeenCalledOnce();
    expect(h.revision()).toBe(0);
    h.actions().updateSimulationEntity({ ...path, name: "断链待修" });
    expect(h.scene().simulationEntities?.[0]).toMatchObject({ name: "断链待修" });
  });

  it("does not write stale actions into another scene or resurrect a deleted entity", () => {
    const h = harness();
    const stale = h.actions();
    h.setScene({ id: "other", simulationEntities: [] } as unknown as SceneSnapshot);
    stale.updateSimulationEntity({ ...path, speed: 3 });
    stale.deleteSimulationEntity("path");
    expect(h.scene()).toEqual({ id: "other", simulationEntities: [] });
  });

  it("keeps edits made during a save and ignores responses after switching scenes", () => {
    const submitted = harness().scene();
    const saved = structuredClone(submitted);
    const edited = { ...submitted, simulationEntities: [] };
    expect(mergeSavedSimulationScene(edited, submitted, saved)?.simulationEntities).toEqual([]);
    expect(mergeSavedSimulationScene(submitted, submitted, saved)).toBe(saved);
    const other = { ...submitted, id: "other" };
    expect(mergeSavedSimulationScene(other, submitted, saved)).toBe(other);
    expect(mergeSavedSimulationScene(undefined, submitted, saved)).toBeUndefined();
  });
});
