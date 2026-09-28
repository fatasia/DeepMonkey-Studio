import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANIMATION } from "../appDefaults";
import { createSceneAnimationCommands } from "./sceneAnimationCommands";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";
import { createTransientRegistry } from "../viewer/transientChannel";

describe("scene animation commands", () => {
  it("records at double-click time and overwrites the same frame without losing its transition", () => {
    const camera = { position: { x: 3, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" };
    const setSceneAnimation = vi.fn();
    const commands = createSceneAnimationCommands({
      engine: { getCameraState: () => camera, setSceneAnimation: vi.fn() },
      sceneAnimation: { ...DEFAULT_ANIMATION, camera: [{ id: "existing", time: 4, camera, transition: "step" }] },
      animationTime: 0, setSceneAnimation, setMessage: vi.fn(), recordSceneEdit: vi.fn(),
    } as unknown as SceneEditorControllerContext);
    expect(commands.addCameraKeyframe(4)).toBe("existing");
    expect(setSceneAnimation.mock.calls[0]![0].camera).toEqual([{ id: "existing", time: 4, camera, transition: "step" }]);
  });
  it("records another existing object track without changing viewport selection", () => {
    const setSceneAnimation = vi.fn();
    const engine = {
      listModels: vi.fn(() => [{ id: "selected", name: "泵" }, { id: "track-object", name: "机械臂" }]),
      isModelLocked: vi.fn(() => false),
      getModelTransform: vi.fn(() => ({ position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })),
      getAnimationPlayback: vi.fn(() => undefined),
      setSceneAnimation: vi.fn(),
    };
    const commands = createSceneAnimationCommands({
      engine,
      selected: { id: "selected", name: "泵" },
      sceneAnimation: structuredClone(DEFAULT_ANIMATION),
      animationTime: 2,
      animationPlaying: false,
      setSceneAnimation,
      setMessage: vi.fn(),
      recordSceneEdit: vi.fn(),
    } as unknown as SceneEditorControllerContext);

    commands.addModelKeyframe("track-object");

    expect(engine.getModelTransform).toHaveBeenCalledWith("track-object");
    expect(setSceneAnimation.mock.calls[0]?.[0].models[0]).toMatchObject({ modelId: "track-object", time: 2 });
  });

  it("uses the live playhead for commands while the shell time is held during playback", () => {
    const setSceneAnimation = vi.fn();
    const transientChannels = createTransientRegistry({ schedule: () => 0, cancel: () => {} });
    transientChannels.channel("animation").publish({ time: 3.25, playing: true });
    const commands = createSceneAnimationCommands({
      engine: { getCameraState: () => ({ position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }), setSceneAnimation: vi.fn(), transientChannels },
      sceneAnimation: structuredClone(DEFAULT_ANIMATION),
      animationTime: 0,
      animationPlaying: true,
      setSceneAnimation,
      setMessage: vi.fn(),
      recordSceneEdit: vi.fn(),
    } as unknown as SceneEditorControllerContext);

    commands.addCameraKeyframe();

    expect(setSceneAnimation.mock.calls[0]?.[0].camera[0].time).toBe(3.25);
    transientChannels.dispose();
  });

  it("reverse play flips direction and starts playback while forward play resets the direction", () => {
    const engine = { setSceneAnimationDirection: vi.fn(), playSceneAnimation: vi.fn(), pauseSceneAnimation: vi.fn() };
    const commands = createSceneAnimationCommands({
      engine,
      sceneAnimation: structuredClone(DEFAULT_ANIMATION),
      animationTime: 0,
      animationPlaying: false,
      setSceneAnimation: vi.fn(),
      setMessage: vi.fn(),
    } as unknown as SceneEditorControllerContext);

    commands.reverseSceneAnimation();
    expect(engine.setSceneAnimationDirection).toHaveBeenLastCalledWith(-1);
    expect(engine.playSceneAnimation).toHaveBeenCalledTimes(1);

    commands.toggleSceneAnimation();
    expect(engine.setSceneAnimationDirection).toHaveBeenLastCalledWith(1);
    expect(engine.playSceneAnimation).toHaveBeenCalledTimes(2);
  });

  it("reverse during playback flips direction without restarting or pausing", () => {
    const engine = { setSceneAnimationDirection: vi.fn(), playSceneAnimation: vi.fn(), pauseSceneAnimation: vi.fn() };
    const commands = createSceneAnimationCommands({
      engine,
      sceneAnimation: structuredClone(DEFAULT_ANIMATION),
      animationTime: 3,
      animationPlaying: true,
      setSceneAnimation: vi.fn(),
      setMessage: vi.fn(),
    } as unknown as SceneEditorControllerContext);

    commands.reverseSceneAnimation();
    expect(engine.setSceneAnimationDirection).toHaveBeenCalledWith(-1);
    expect(engine.playSceneAnimation).not.toHaveBeenCalled();
    expect(engine.pauseSceneAnimation).not.toHaveBeenCalled();
  });

  it("routes keyframe edits into the unified undo ledger while playback controls stay transient (T27)", () => {
    const camera = { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" };
    const engine = {
      getCameraState: () => camera,
      setSceneAnimation: vi.fn(),
      setSceneAnimationDirection: vi.fn(),
      playSceneAnimation: vi.fn(),
      pauseSceneAnimation: vi.fn(),
      listModels: vi.fn(() => [{ id: "arm", name: "机械臂" }]),
      isModelLocked: vi.fn(() => false),
      getModelTransform: vi.fn(() => ({ position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })),
      getAnimationPlayback: vi.fn(() => undefined),
    };
    const recordSceneEdit = vi.fn();
    const commands = createSceneAnimationCommands({
      engine,
      selected: { id: "arm", name: "机械臂" },
      sceneAnimation: { ...structuredClone(DEFAULT_ANIMATION), camera: [{ id: "frame", time: 1, camera }] },
      animationTime: 1,
      animationPlaying: false,
      setSceneAnimation: vi.fn(),
      setMessage: vi.fn(),
      recordSceneEdit,
    } as unknown as SceneEditorControllerContext);

    commands.addCameraKeyframe(1);
    commands.addModelKeyframe("arm", 1);
    commands.deleteKeyframe("frame");
    expect(recordSceneEdit.mock.calls.map(([label]) => label)).toEqual(["记录相机关键帧", "记录对象关键帧", "删除动画关键帧"]);

    recordSceneEdit.mockClear();
    commands.toggleSceneAnimation();
    commands.reverseSceneAnimation();
    commands.updateSceneAnimation(structuredClone(DEFAULT_ANIMATION));
    expect(recordSceneEdit).not.toHaveBeenCalled();
  });

  it("routes even a no-op deletion through the ledger, which dedupes it by snapshot fingerprint", () => {
    const recordSceneEdit = vi.fn();
    const commands = createSceneAnimationCommands({
      engine: { setSceneAnimation: vi.fn() },
      sceneAnimation: structuredClone(DEFAULT_ANIMATION),
      animationTime: 0,
      animationPlaying: false,
      setSceneAnimation: vi.fn(),
      setMessage: vi.fn(),
      recordSceneEdit,
    } as unknown as SceneEditorControllerContext);

    commands.deleteKeyframe("missing");
    expect(recordSceneEdit).toHaveBeenCalledOnce();
  });
});
