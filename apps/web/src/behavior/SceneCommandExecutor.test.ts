import type { SceneCommand, SceneObjectRef } from "@bim-studio/scene-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  SCENE_COMMAND_APPLIED,
  SceneCommandExecutor,
  type SceneCommandPort,
  type SceneCommandPortOutcome
} from "./SceneCommandExecutor";

describe("SceneCommandExecutor", () => {
  it("maps all command types to the port in deterministic order", async () => {
    const calls: string[] = [];
    const port = createPort(calls);
    const executor = new SceneCommandExecutor("scene-1", port);
    const commands: SceneCommand[] = [
      { id: "visibility", type: "object.set-visibility", target: objectRef(), visible: false },
      { id: "transform", type: "object.set-transform", target: objectRef(), position: [1, 2, 3] },
      { id: "selection", type: "selection.set", targets: [objectRef()] },
      { id: "camera", type: "camera.set", sceneId: "scene-1", position: [1, 2, 3], target: [0, 0, 0], far: 5_000 },
      { id: "fly", type: "camera.fly-to", sceneId: "scene-1", target: { position: [4, 5, 6] }, durationMs: 800 },
      { id: "animation", type: "animation.control", target: objectRef(), action: "seek", clipId: "clip-1", time: 2.5 },
      { id: "data", type: "data.apply", target: objectRef(), values: { temperature: 42 }, timestamp: "2026-08-25T12:00:00Z" },
      { id: "component", type: "component.update", componentId: "widget-1", patch: { visible: true } }
    ];

    const results = await executor.execute(commands);

    expect(calls).toEqual(["visibility", "transform", "selection", "camera", "fly", "animation", "data", "component"]);
    expect(results).toEqual(commands.map((command, index) => ({ index, id: command.id, type: command.type, success: true })));
    expect(port.setObjectTransform).toHaveBeenCalledWith(objectRef(), { position: [1, 2, 3] });
    expect(port.setCamera).toHaveBeenCalledWith("scene-1", { position: [1, 2, 3], target: [0, 0, 0], far: 5_000 });
    expect(port.controlAnimation).toHaveBeenCalledWith(objectRef(), { action: "seek", clipId: "clip-1", time: 2.5 });
    expect(port.updateComponent).toHaveBeenCalledWith("widget-1", { visible: true });
  });

  it("rejects cross-scene command and selection targets before touching the port", async () => {
    const port = createPort();
    const executor = new SceneCommandExecutor("scene-1", port);
    const commands: SceneCommand[] = [
      { id: "wrong-camera", type: "camera.set", sceneId: "scene-2", position: [0, 0, 1], target: [0, 0, 0] },
      { id: "wrong-target", type: "selection.set", targets: [objectRef(), objectRef("scene-3")] }
    ];

    const results = await executor.execute(commands);

    expect(results).toMatchObject([
      { id: "wrong-camera", success: false, code: "scene-mismatch" },
      { id: "wrong-target", success: false, code: "scene-mismatch" }
    ]);
    expect(results[1]?.success === false && results[1].message).toContain("目标 2");
    expect(port.setCamera).not.toHaveBeenCalled();
    expect(port.setSelection).not.toHaveBeenCalled();
  });

  it("reports explicit unsupported targets without claiming they were applied", async () => {
    const port = createPort();
    port.setObjectTransform = vi.fn(async (target): Promise<SceneCommandPortOutcome> => {
      if (target.kind === "mesh") return { status: "unsupported", message: "当前 ViewerEngine 尚未支持 mesh 级变换。" };
      return SCENE_COMMAND_APPLIED;
    });
    const executor = new SceneCommandExecutor("scene-1", port);

    const [result] = await executor.execute([
      {
        id: "mesh-transform",
        type: "object.set-transform",
        target: { kind: "mesh", sceneId: "scene-1", objectId: "robot", meshId: "arm" },
        rotation: [0, 1, 0]
      }
    ]);

    expect(result).toEqual({
      index: 0,
      id: "mesh-transform",
      type: "object.set-transform",
      success: false,
      code: "unsupported",
      message: "当前 ViewerEngine 尚未支持 mesh 级变换。"
    });
  });

  it("keeps executing after a port failure and preserves command ids", async () => {
    const port = createPort();
    port.setObjectVisibility = vi.fn()
      .mockRejectedValueOnce(new Error("模型不存在"))
      .mockResolvedValueOnce(SCENE_COMMAND_APPLIED);
    const executor = new SceneCommandExecutor("scene-1", port);
    const commands: SceneCommand[] = [
      { id: "missing", type: "object.set-visibility", target: objectRef(), visible: false },
      { id: "valid", type: "object.set-visibility", target: objectRef(), visible: true }
    ];

    const results = await executor.execute(commands);

    expect(port.setObjectVisibility).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { index: 0, id: "missing", type: "object.set-visibility", success: false, code: "port-error", message: "模型不存在" },
      { index: 1, id: "valid", type: "object.set-visibility", success: true }
    ]);
  });

  it("requires a non-empty active scene id", () => {
    expect(() => new SceneCommandExecutor("  ", createPort())).toThrow("当前场景 ID 不能为空");
  });
});

function objectRef(sceneId = "scene-1"): SceneObjectRef {
  return { kind: "object", sceneId, objectId: "robot" };
}

function createPort(calls: string[] = []): SceneCommandPort & Record<keyof SceneCommandPort, ReturnType<typeof vi.fn>> {
  const method = (name: string) => vi.fn(async () => {
    calls.push(name);
    return SCENE_COMMAND_APPLIED;
  });
  return {
    setObjectVisibility: method("visibility"),
    setObjectTransform: method("transform"),
    setSelection: method("selection"),
    setCamera: method("camera"),
    flyCamera: method("fly"),
    controlAnimation: method("animation"),
    applyData: method("data"),
    updateComponent: method("component")
  };
}
