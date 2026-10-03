import { describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { SceneCommandExecutor } from "./SceneCommandExecutor";
import { ViewerSceneCommandPort } from "./ViewerSceneCommandPort";

describe("ViewerSceneCommandPort", () => {
  it("applies supported object, camera, and data commands through public viewer methods", async () => {
    const viewer = fakeViewer();
    const executor = new SceneCommandExecutor("scene-1", new ViewerSceneCommandPort(viewer));
    const results = await executor.execute([
      { id: "visible", type: "object.set-visibility", target: objectRef(), visible: false },
      { id: "move", type: "object.set-transform", target: objectRef(), position: [1, 2, 3] },
      { id: "material", type: "material.set", target: objectRef(), patch: { roughness: 0.25, metalness: 0.75 } },
      { id: "camera", type: "camera.set", sceneId: "scene-1", position: [2, 3, 4], target: [0, 0, 0], near: 0.1, far: 1000 },
      {
        id: "data",
        type: "data.apply",
        target: objectRef(),
        values: { color: "#ff0000", effects: { fire: { enabled: true, intensity: 3.2 } }, ignored: 1 },
        timestamp: "2026-08-25T00:00:00.000Z",
      }
    ]);

    expect(results.every((result) => result.success)).toBe(true);
    expect(viewer.setVisible).toHaveBeenCalledWith("robot", false);
    expect(viewer.setModelTransform).toHaveBeenCalledWith("robot", { position: [1, 2, 3] });
    expect(viewer.setModelMaterial).toHaveBeenCalledWith("robot", { roughness: 0.25, metalness: 0.75 });
    expect(viewer.setCameraPose).toHaveBeenCalledWith(expect.objectContaining({ near: 0.1, far: 1000 }));
    expect(viewer.applySceneDataMessage).toHaveBeenCalledTimes(2);
    expect(viewer.applySceneDataMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: "effects",
      value: { fire: { enabled: true, intensity: 3.2 } },
    }));
  });

  it("reports unsupported precision instead of pretending advanced operations succeeded", async () => {
    const viewer = fakeViewer();
    const frozenSchedule = { requestFrame: () => 0, cancelFrame: () => {}, now: () => 0 };
    const executor = new SceneCommandExecutor("scene-1",
      new ViewerSceneCommandPort(viewer, undefined, undefined, frozenSchedule));
    const results = await executor.execute([
      { id: "multi", type: "selection.set", targets: [objectRef(), { ...objectRef(), objectId: "robot-2" }] },
      { id: "fly", type: "camera.fly-to", sceneId: "scene-1", target: objectRef(), durationMs: 800 },
      { id: "fly-too-long", type: "camera.fly-to", sceneId: "scene-1", target: objectRef(), durationMs: 40_000 },
      { id: "seek", type: "animation.control", target: objectRef(), action: "seek", time: 1 }
    ]);

    expect(results).toEqual([
      expect.objectContaining({ id: "multi", success: false, code: "unsupported" }),
      // H-C7-P3 生产接线:时长飞行经宿主 Tween 播放层起飞(即时逼近解析终点,从真实起点起飞)。
      expect.objectContaining({ id: "fly", success: true }),
      expect.objectContaining({ id: "fly-too-long", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "seek", success: true })
    ]);
    // 起飞序列:回起点一帧 + 起点/终点解析写入(frozen now 下停在起点采样,不推进)。
    expect(viewer.setCameraPose).toHaveBeenCalledWith(expect.objectContaining({ position: [0, 2, 4] }));
  });

  it("rejects locked material writes and invalid shader source before author mutation", () => {
    const viewer = fakeViewer();
    const port = new ViewerSceneCommandPort(viewer);
    vi.mocked(viewer.isModelLocked).mockReturnValueOnce(true);
    expect(port.setObjectMaterial(objectRef(), { roughness: 0.2 })).toMatchObject({ status: "unsupported", message: expect.stringContaining("已锁定") });
    expect(port.setObjectMaterial(objectRef(), { customShader: { source: "shader invalid { unknownField 1; }" } })).toMatchObject({ status: "unsupported", message: expect.stringContaining("编译失败") });
    expect(viewer.setModelMaterial).not.toHaveBeenCalled();
  });

  it("保存合法作者源码且不把编译通过当作画面认证", () => {
    const viewer = fakeViewer();
    const source = `shader deep.material {
  surface standard;
  baseColor [0.2, 0.4, 0.6, 1];
  metallic 0;
  roughness 0.5;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;
    const port = new ViewerSceneCommandPort(viewer);
    expect(port.setObjectMaterial(objectRef(), { customShader: { source } })).toEqual({ status: "applied" });
    expect(viewer.setModelMaterial).toHaveBeenCalledWith("robot", { customShader: { source } });
  });

  it("rejects commands targeting a model that is not loaded", async () => {
    const viewer = fakeViewer();
    const executor = new SceneCommandExecutor("scene-1", new ViewerSceneCommandPort(viewer));
    const missing = { ...objectRef(), objectId: "missing" };
    const results = await executor.execute([
      { id: "visible", type: "object.set-visibility", target: missing, visible: false },
      { id: "selection", type: "selection.set", targets: [missing] },
      { id: "data", type: "data.apply", target: missing, values: { color: "#ff0000" }, timestamp: "2026-08-25T00:00:00.000Z" }
    ]);

    expect(results).toEqual([
      expect.objectContaining({ id: "visible", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "selection", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "data", success: false, code: "unsupported" })
    ]);
    expect(viewer.setVisible).not.toHaveBeenCalled();
    expect(viewer.select).not.toHaveBeenCalled();
    expect(viewer.applySceneDataMessage).not.toHaveBeenCalled();
  });

  it("H-C7-P3:animation.set-anchor 迁移引擎权威态锚(单锚/双锚经全量回写)", async () => {
    const viewer = fakeViewer();
    const executor = new SceneCommandExecutor("scene-1", new ViewerSceneCommandPort(viewer));
    const results = await executor.execute([
      { id: "anchor-1", type: "animation.set-anchor", sceneId: "scene-1", anchor: { activeStateId: "work" } },
      { id: "anchor-2", type: "animation.set-anchor", sceneId: "scene-1", anchor: { initialStateId: "work", activeStateId: "idle" } }
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(viewer.setSceneAnimation).toHaveBeenCalledTimes(2);
    const [secondWrite] = vi.mocked(viewer.setSceneAnimation).mock.calls[1] as [unknown];
    expect(secondWrite).toMatchObject({
      stateMachine: expect.objectContaining({ initialStateId: "work", activeStateId: "idle" })
    });
    // 未给出的锚不被命令触碰:第一次只写 activeStateId。
    const [firstWrite] = vi.mocked(viewer.setSceneAnimation).mock.calls[0] as [unknown];
    expect(firstWrite).toMatchObject({
      stateMachine: expect.objectContaining({ initialStateId: "idle", activeStateId: "work" })
    });
  });

  it("H-C7-P3 fail-closed:未知状态/无状态机拒绝,不触碰引擎", async () => {
    const viewer = fakeViewer();
    const port = new ViewerSceneCommandPort(viewer);
    const unknown = port.setAnimationAnchor("scene-1", { initialStateId: "ghost" });
    expect(unknown).toMatchObject({ status: "unsupported", message: expect.stringContaining("迁移拒绝") });
    expect(unknown.status === "unsupported" && unknown.message).toContain("ghost");
    const noMachine = fakeViewer();
    vi.mocked(noMachine.getSceneAnimation).mockReturnValue({
      duration: 1, loop: false, camera: [], models: []
    } as never);
    const absent = new ViewerSceneCommandPort(noMachine).setAnimationAnchor("scene-1", { activeStateId: "work" });
    expect(absent).toMatchObject({ status: "unsupported", message: expect.stringContaining("没有动画状态机") });
    expect(noMachine.setSceneAnimation).not.toHaveBeenCalled();
    expect(viewer.setSceneAnimation).not.toHaveBeenCalled();
  });
});

function objectRef() {
  return { kind: "object" as const, sceneId: "scene-1", objectId: "robot" };
}

function fakeViewer(): ViewerEngine & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listModels: vi.fn(() => [{ id: "robot" }]),
    isModelLocked: vi.fn(() => false),
    setVisible: vi.fn(),
    setLayerVisible: vi.fn(),
    setModelTransform: vi.fn(() => true),
    setModelMaterial: vi.fn(),
    select: vi.fn(),
    selectLayer: vi.fn(),
    setCameraPose: vi.fn(),
    getCameraState: vi.fn(() => ({ position: { x: 0, y: 2, z: 4 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" })),
    fitAll: vi.fn(),
    focusModel: vi.fn(() => true),
    hasAnimation: vi.fn(() => true),
    controlAnimation: vi.fn(() => true),
    setAnimationEnabled: vi.fn(),
    applySceneDataMessage: vi.fn(() => true),
    // H-C7-P3:状态机锚迁移读写面(引擎权威态;伪实现直接替换整份 SceneAnimationState)。
    getSceneAnimation: vi.fn(() => ({
      duration: 1, loop: false, camera: [], models: [],
      stateMachine: {
        enabled: true, initialStateId: "idle", activeStateId: "idle", transitionDuration: 0.25,
        states: [
          { id: "idle", name: "Idle", modelId: "robot", clipId: "Idle", loop: true },
          { id: "work", name: "Work", modelId: "robot", clipId: "Work", loop: false }
        ]
      }
    })),
    setSceneAnimation: vi.fn()
  } as unknown as ViewerEngine & Record<string, ReturnType<typeof vi.fn>>;
}
