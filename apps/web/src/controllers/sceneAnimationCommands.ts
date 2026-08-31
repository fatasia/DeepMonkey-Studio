import type { SceneAnimationState } from "@bim-studio/contracts";
import { snapAnimationTime } from "../viewer/timeline";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

/** 相机与模型关键帧命令；沿用查看器当前姿态，不在 UI 层复制时间线算法。 */
export function createSceneAnimationCommands(context: SceneEditorControllerContext) {
  const { engine, selected, sceneAnimation, animationTime, animationPlaying, setSceneAnimation, setMessage } = context;

  function updateSceneAnimation(next: SceneAnimationState) {
    setSceneAnimation(next);
    engine?.setSceneAnimation(next);
  }

  function addCameraKeyframe() {
    if (!engine) return;
    const frameTime = snapAnimationTime(animationTime, sceneAnimation.frameRate, sceneAnimation.snapToFrames);
    const frame = { id: crypto.randomUUID(), time: frameTime, camera: engine.getCameraState() };
    updateSceneAnimation({
      ...sceneAnimation,
      camera: [...sceneAnimation.camera.filter((item) => Math.abs(item.time - frameTime) > 0.001), frame].sort((left, right) => left.time - right.time),
    });
    setMessage(`已在 ${frameTime.toFixed(2)} 秒记录相机关键帧`);
  }

  function addModelKeyframe() {
    if (!engine || !selected) return;
    const transform = engine.getModelTransform(selected.id);
    if (!transform) return;
    const playback = engine.getAnimationPlayback(selected.id);
    const frameTime = snapAnimationTime(animationTime, sceneAnimation.frameRate, sceneAnimation.snapToFrames);
    const frame = {
      id: crypto.randomUUID(),
      time: frameTime,
      modelId: selected.id,
      transform,
      ...(playback ? { animation: { ...(playback.clipId ? { clipId: playback.clipId } : {}), time: playback.time } } : {}),
    };
    updateSceneAnimation({
      ...sceneAnimation,
      models: [...sceneAnimation.models.filter((item) => item.modelId !== selected.id || Math.abs(item.time - frameTime) > 0.001), frame].sort(
        (left, right) => left.time - right.time,
      ),
    });
    setMessage(playback ? `已为“${selected.name}”记录 ${frameTime.toFixed(2)} 秒对象与片段关键帧` : `已为“${selected.name}”记录 ${frameTime.toFixed(2)} 秒关键帧`);
  }

  function toggleSceneAnimation() {
    if (!engine) return;
    if (animationPlaying) engine.pauseSceneAnimation();
    else engine.playSceneAnimation();
  }

  function deleteKeyframe(id: string) {
    updateSceneAnimation({
      ...sceneAnimation,
      camera: sceneAnimation.camera.filter((item) => item.id !== id),
      models: sceneAnimation.models.filter((item) => item.id !== id),
    });
  }

  return { updateSceneAnimation, addCameraKeyframe, addModelKeyframe, toggleSceneAnimation, deleteKeyframe };
}
