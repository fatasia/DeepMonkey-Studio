import type * as THREE from "three";

/**
 * 被追踪 clip 动作的当前播放头(秒)。`mixer.time` 是全局累计量(stop/seek 外不归零),
 * play 仅 `reset().play()` 单个 action,因此运行中的相位必须取 action.time:loop 下 three 已折回
 * [0,duration),once 下钳在 duration。动作未被调度(未播放/已 stop,此时 scrub 只更新 mixer.time)
 * 时回退 mixer.time,保持停止态下拖动时间轴的读数。
 */
export function actionPlayhead(mixer: THREE.AnimationMixer, clip: THREE.AnimationClip, loopMode: "once" | "loop"): number {
  if (!(clip.duration > 0)) return 0;
  const action = mixer.existingAction(clip);
  const raw = Math.max(0, action?.isScheduled() ? action.time : mixer.time);
  return loopMode === "loop" ? raw % clip.duration : Math.min(raw, clip.duration);
}