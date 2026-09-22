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

  function addCameraKeyframe(time = animationTime) {
    if (!engine) return;
    const frameTime = snapAnimationTime(time, sceneAnimation.frameRate, sceneAnimation.snapToFrames);
    const previous = sceneAnimation.camera.find(item => Math.abs(item.time - frameTime) <= 0.001);
    const frame = { ...previous, id: previous?.id ?? crypto.randomUUID(), time: frameTime, camera: engine.getCameraState() };
    updateSceneAnimation({
      ...sceneAnimation,
      camera: [...sceneAnimation.camera.filter((item) => Math.abs(item.time - frameTime) > 0.001), frame].sort((left, right) => left.time - right.time),
    });
    setMessage(`已在 ${frameTime.toFixed(2)} 秒记录相机关键帧`);
    return frame.id;
  }

  function addModelKeyframe(modelId = selected?.id, time = animationTime) {
    if (!engine || !modelId) return;
    const model = engine.listModels().find((item) => item.id === modelId);
    if (!model || engine.isModelLocked(modelId)) return;
    const transform = engine.getModelTransform(modelId);
    if (!transform) return;
    const playback = engine.getAnimationPlayback(modelId);
    const frameTime = snapAnimationTime(time, sceneAnimation.frameRate, sceneAnimation.snapToFrames);
    const previous = sceneAnimation.models.find(item => item.modelId === modelId && Math.abs(item.time - frameTime) <= 0.001);
    const frame = {
      ...previous,
      id: previous?.id ?? crypto.randomUUID(),
      time: frameTime,
      modelId,
      transform,
      ...(playback ? { animation: { ...(playback.clipId ? { clipId: playback.clipId } : {}), time: playback.time } } : {}),
    };
    updateSceneAnimation({
      ...sceneAnimation,
      models: [...sceneAnimation.models.filter((item) => item.modelId !== modelId || Math.abs(item.time - frameTime) > 0.001), frame].sort(
        (left, right) => left.time - right.time,
      ),
    });
    setMessage(playback ? `已为“${model.name}”记录 ${frameTime.toFixed(2)} 秒对象与片段关键帧` : `已为“${model.name}”记录 ${frameTime.toFixed(2)} 秒关键帧`);
    return frame.id;
  }

  function toggleSceneAnimation() {
    if (!engine) return;
    if (animationPlaying) engine.pauseSceneAnimation();
    else {
      // 播放按钮固定为正向起步，避免上次倒放的方向残留；倒放走独立入口。
      engine.setSceneAnimationDirection(1);
      engine.playSceneAnimation();
    }
  }

  function reverseSceneAnimation() {
    if (!engine) return;
    // 倒放：暂停时从当前区间边界反向起步，播放中立即掉头。
    engine.setSceneAnimationDirection(-1);
    if (!animationPlaying) engine.playSceneAnimation();
  }

  function deleteKeyframe(id: string) {
    updateSceneAnimation({
      ...sceneAnimation,
      camera: sceneAnimation.camera.filter((item) => item.id !== id),
      models: sceneAnimation.models.filter((item) => item.id !== id),
    });
  }

  return { updateSceneAnimation, addCameraKeyframe, addModelKeyframe, toggleSceneAnimation, reverseSceneAnimation, deleteKeyframe };
}
