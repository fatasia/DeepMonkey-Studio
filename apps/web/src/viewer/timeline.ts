import type {
  CameraKeyframe,
  CameraState,
  KeyframeTransition,
  ModelAnimationKeyframeState,
  ModelKeyframe,
  ModelTransform,
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
