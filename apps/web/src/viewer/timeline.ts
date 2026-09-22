import type {
  CameraKeyframe,
  CameraState,
  KeyframeTransition,
  ModelAnimationKeyframeState,
  ModelKeyframe,
  ModelTransform,
  SceneAnimationPlaybackRange,
  SceneAnimationState,
  Vector3Value
} from "@bim-studio/contracts";

export function normalizeAnimationFrameRate(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(120, Math.round(value!)));
}

export function snapAnimationTime(time: number, frameRate: number | undefined, enabled = true): number {
  if (!enabled) return time;
  const fps = normalizeAnimationFrameRate(frameRate);
  return Math.round(time * fps) / fps;
}

/** 把任意播放区间收敛到合法子区间；越界值夹到时间线内，出点不大于入点时回落整条时间线。 */
export function normalizeSceneAnimationPlaybackRange(
  range: SceneAnimationPlaybackRange | undefined,
  duration: number,
): SceneAnimationPlaybackRange {
  const inPoint = Math.min(Math.max(range?.inPoint ?? 0, 0), duration);
  const outPoint = Math.min(Math.max(range?.outPoint ?? duration, 0), duration);
  if (!(outPoint > inPoint)) return { inPoint: 0, outPoint: duration };
  return { inPoint, outPoint };
}

/** 时间线采样入口：把任意输入时间收敛到播放区间后再交给关键帧采样器，吸附到帧的溢出同样不得越出区间。 */
export function sampleSceneAnimation(
  animation: Pick<SceneAnimationState, "duration" | "playbackRange" | "frameRate" | "snapToFrames">,
  time: number,
): number {
  const range = normalizeSceneAnimationPlaybackRange(animation.playbackRange, animation.duration);
  const snapped = snapAnimationTime(Math.min(Math.max(time, range.inPoint), range.outPoint), animation.frameRate, animation.snapToFrames ?? false);
  return Math.min(Math.max(snapped, range.inPoint), range.outPoint);
}

export interface SceneAnimationAdvanceInput {
  /** 当前播放头（秒）。 */
  time: number;
  delta: number;
  speed: number;
  /** 播放方向：1 正向，-1 倒放。 */
  direction: 1 | -1;
  loop: boolean;
  pingPong: boolean;
  /** 已规范化的播放区间，调用方保证 outPoint > inPoint。 */
  range: SceneAnimationPlaybackRange;
}

export interface SceneAnimationAdvanceResult {
  time: number;
  direction: 1 | -1;
  /** 到达边界且不再循环时为真，调用方应暂停播放。 */
  stop: boolean;
}

/** 推进一帧播放头：循环折回、往返反弹与单次停止都以播放区间为边界，正向与倒放共用同一套语义。 */
export function advanceSceneAnimationTime(input: SceneAnimationAdvanceInput): SceneAnimationAdvanceResult {
  const direction = input.direction;
  let time = input.time + input.delta * input.speed * direction;
  if (time >= input.range.outPoint || time <= input.range.inPoint) {
    if (input.pingPong) {
      time = Math.min(Math.max(time, input.range.inPoint), input.range.outPoint);
      const flipped = direction > 0 ? -1 : 1;
      // 非循环往返在回到正向那一刻结束，保持与整条时间线一致的一次往返语义。
      if (!input.loop && flipped > 0) return { time, direction: flipped, stop: true };
      return { time, direction: flipped, stop: false };
    }
    if (input.loop) {
      // 双取模把正向与反向的越界都折回区间内，与整条时间线循环的环绕语义一致。
      const span = input.range.outPoint - input.range.inPoint;
      time = input.range.inPoint + (((time - input.range.inPoint) % span) + span) % span;
      return { time, direction, stop: false };
    }
    return { time: direction > 0 ? input.range.outPoint : input.range.inPoint, direction, stop: true };
  }
  return { time, direction, stop: false };
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number): number {
  const clamped = clampProgress(value);
  return clamped * clamped * (3 - 2 * clamped);
}

type CameraInterpolation = "linear" | "smooth" | "spline";

export function transitionProgress(progress: number, transition: KeyframeTransition | "spline"): number {
  const t = clampProgress(progress);
  if (transition === "step") return t < 1 ? 0 : 1;
  if (transition === "smooth") return smoothStep(t);
  if (transition === "ease-in") return t * t;
  if (transition === "ease-out") return 1 - (1 - t) * (1 - t);
  return t;
}

function interpolateVector(start: Vector3Value, end: Vector3Value, progress: number, smooth = true): Vector3Value {
  const amount = smooth ? smoothStep(progress) : clampProgress(progress);
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    z: start.z + (end.z - start.z) * amount
  };
}

function catmullRomVector(p0: Vector3Value, p1: Vector3Value, p2: Vector3Value, p3: Vector3Value, progress: number): Vector3Value {
  const amount = clampProgress(progress);
  const amount2 = amount * amount;
  const amount3 = amount2 * amount;
  const component = (a: number, b: number, c: number, d: number) => 0.5 * (
    2 * b + (-a + c) * amount + (2 * a - 5 * b + 4 * c - d) * amount2 + (-a + 3 * b - 3 * c + d) * amount3
  );
  return {
    x: component(p0.x, p1.x, p2.x, p3.x),
    y: component(p0.y, p1.y, p2.y, p3.y),
    z: component(p0.z, p1.z, p2.z, p3.z)
  };
}

function interpolateAngle(start: number, end: number, progress: number): number {
  const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  return start + delta * clampProgress(progress);
}

function surroundingFrames<T extends { time: number }>(frames: T[], time: number): [T, T, number] | undefined {
  if (frames.length === 0) return undefined;
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  if (time <= sorted[0]!.time) return [sorted[0]!, sorted[0]!, 0];
  if (time >= sorted.at(-1)!.time) return [sorted.at(-1)!, sorted.at(-1)!, 0];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index]!;
    const end = sorted[index + 1]!;
    if (time < start.time || time > end.time) continue;
    const duration = Math.max(end.time - start.time, 0.0001);
    return [start, end, (time - start.time) / duration];
  }
  return undefined;
}

export function sampleCameraKeyframes(
  frames: CameraKeyframe[],
  time: number,
  interpolation: CameraInterpolation = "smooth"
): CameraState | undefined {
  const sample = surroundingFrames(frames, time);
  if (!sample) return undefined;
  const [start, end, progress] = sample;
  const mode = start.transition ?? interpolation;
  const amount = transitionProgress(progress, mode);
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  const startIndex = Math.max(sorted.findIndex((frame) => frame.id === start.id), 0);
  const p0 = sorted[Math.max(0, startIndex - 1)] ?? start;
  const p3 = sorted[Math.min(sorted.length - 1, startIndex + 2)] ?? end;
  const position = mode === "spline" && start !== end
    ? catmullRomVector(p0.camera.position, start.camera.position, end.camera.position, p3.camera.position, progress)
    : interpolateVector(start.camera.position, end.camera.position, amount, false);
  const target = mode === "spline" && start !== end
    ? catmullRomVector(p0.camera.target, start.camera.target, end.camera.target, p3.camera.target, progress)
    : interpolateVector(start.camera.target, end.camera.target, amount, false);
  return {
    position,
    target,
    mode: amount < 0.5 ? start.camera.mode : end.camera.mode,
    ...((amount < 0.5 ? start.camera.avatarVisible : end.camera.avatarVisible) === undefined ? {} : {
      avatarVisible: amount < 0.5 ? start.camera.avatarVisible : end.camera.avatarVisible
    })
  };
}

export function sampleModelKeyframes(frames: ModelKeyframe[], time: number, interpolation: "linear" | "smooth" = "smooth"): ModelTransform | undefined {
  const sample = surroundingFrames(frames, time);
  if (!sample) return undefined;
  const [start, end, progress] = sample;
  const amount = transitionProgress(progress, start.transition ?? interpolation);
  return {
    position: interpolateVector(start.transform.position, end.transform.position, amount, false),
    rotation: {
      x: interpolateAngle(start.transform.rotation.x, end.transform.rotation.x, amount),
      y: interpolateAngle(start.transform.rotation.y, end.transform.rotation.y, amount),
      z: interpolateAngle(start.transform.rotation.z, end.transform.rotation.z, amount)
    },
    scale: interpolateVector(start.transform.scale, end.transform.scale, amount, false)
  };
}

export function sampleModelAnimationKeyframes(frames: ModelKeyframe[], time: number): ModelAnimationKeyframeState | undefined {
  const animated = frames.filter((frame) => frame.animation);
  const sample = surroundingFrames(animated, time);
  if (!sample) return undefined;
  const [start, end, progress] = sample;
  const startAnimation = start.animation!;
  const endAnimation = end.animation!;
  if (start === end || startAnimation.clipId !== endAnimation.clipId) {
    return structuredClone(progress < 1 ? startAnimation : endAnimation);
  }
  return {
    ...(startAnimation.clipId ? { clipId: startAnimation.clipId } : {}),
    time: startAnimation.time + (endAnimation.time - startAnimation.time) * transitionProgress(progress, start.transition ?? "linear")
  };
}
