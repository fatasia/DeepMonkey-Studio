import type { SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSceneOrganizationCommands } from "./sceneOrganizationCommands";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

describe("场景组织命令", () => {
  it("locks every object and advances the revision only once", () => {
    const setModelLocked = vi.fn();
    let revision = 4;
    const commands = createSceneOrganizationCommands({
      engine: { setModelLocked } as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: [],
      sceneOrganizationSelection: new Set(),
      selectionSets: [],
      lastDeletedSelectionSet: undefined,
      setMessage: vi.fn(),
      setRevision: (next: SetStateAction<number>) => {
        revision = typeof next === "function" ? next(revision) : next;
      },
      setSceneOrganizationSelection: vi.fn(),
      setSelectionSets: vi.fn(),
      setLastDeletedSelectionSet: vi.fn(),
    } as unknown as SceneEditorControllerContext);

    commands.setSceneObjectsLocked(["line-a", "line-b"], true);

    expect(setModelLocked.mock.calls).toEqual([
      ["line-a", true],
      ["line-b", true],
    ]);
    expect(revision).toBe(5);
  });
});
