import { describe, expect, it, vi } from "vitest";
import { createSceneEditorController } from "./sceneEditorController";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

describe("locked primitive command boundary", () => {
  it("refuses direct deletion without removing associated data or recording an edit", () => {
    const removeModel = vi.fn();
    const removeObjectInteractions = vi.fn();
    const recordSceneEdit = vi.fn();
    const controller = createSceneEditorController({
      engine: { isModelLocked: () => true, removeModel }, removeObjectInteractions, recordSceneEdit,
    } as unknown as SceneEditorControllerContext);
    controller.deletePrimitive("locked");
    expect(removeModel).not.toHaveBeenCalled();
    expect(removeObjectInteractions).not.toHaveBeenCalled();
    expect(recordSceneEdit).not.toHaveBeenCalled();
  });
});
