import { describe, expect, it } from "vitest";
import { advanceSceneAnimationTime, normalizeAnimationFrameRate, normalizeSceneAnimationPlaybackRange, sampleCameraKeyframes, sampleModelAnimationKeyframes, sampleModelKeyframes, sampleSceneAnimation, snapAnimationTime } from "./timeline";

describe("timeline sampling", () => {
  it("uses each outgoing camera segment's transition including exact hold boundaries", () => {
    const camera = (x: number) => ({ position: { x, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const });
    const frames = [{ id: "a", time: 0, camera: camera(0), transition: "step" as const }, { id: "b", time: 4, camera: camera(4), transition: "ease-in" as const }, { id: "c", time: 8, camera: camera(8) }];
    expect(sampleCameraKeyframes(frames, 3.99)?.position.x).toBe(0);
    expect(sampleCameraKeyframes(frames, 4)?.position.x).toBe(4);
    expect(sampleCameraKeyframes(frames, 6)?.position.x).toBe(5);
    expect(sampleCameraKeyframes(frames, 8)?.position.x).toBe(8);
  });
  it("applies outgoing easing to position, rotation, scale and clip time consistently", () => {
    const transform = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: x / 10, z: 0 }, scale: { x: 1 + x / 10, y: 1, z: 1 } });
    const frames = [{ id: "a", modelId: "m", time: 0, transform: transform(0), animation: { time: 0 }, transition: "ease-out" as const }, { id: "b", modelId: "m", time: 10, transform: transform(10), animation: { time: 10 } }];
    const sampled = sampleModelKeyframes(frames, 5);
    expect(sampled?.position.x).toBe(7.5);
    expect(sampled?.rotation.y).toBeCloseTo(.75);
    expect(sampled?.scale.x).toBe(1.75);
    expect(sampleModelAnimationKeyframes(frames, 5)?.time).toBe(7.5);
  });
  it("snaps frame-authored animation to the configured frame rate", () => {
    expect(snapAnimationTime(1.017, 30)).toBeCloseTo(1.0333333333);
    expect(snapAnimationTime(1.017, 30, false)).toBe(1.017);
    expect(normalizeAnimationFrameRate(500)).toBe(120);
    expect(normalizeAnimationFrameRate(undefined)).toBe(30);
  });

  it("interpolates camera position and target", () => {
    const result = sampleCameraKeyframes([
      { id: "a", time: 0, camera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 }, mode: "orbit" } },
      { id: "b", time: 10, camera: { position: { x: 10, y: 4, z: 0 }, target: { x: 2, y: 0, z: -1 }, mode: "orbit" } }
    ], 5);
    expect(result?.position).toEqual({ x: 5, y: 2, z: 0 });
    expect(result?.target.x).toBe(1);
  });

  it("keeps model samples at the first and last keyframes outside the range", () => {
    const frames = [
      { id: "a", modelId: "model", time: 2, transform: { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      { id: "b", modelId: "model", time: 4, transform: { position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }
    ];
    expect(sampleModelKeyframes(frames, 0)?.position.x).toBe(1);
    expect(sampleModelKeyframes(frames, 8)?.position.x).toBe(3);
  });

  it("supports linear object tracks as well as smooth easing", () => {
    const frames = [
      { id: "a", modelId: "model", time: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      { id: "b", modelId: "model", time: 10, transform: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }
    ];
    expect(sampleModelKeyframes(frames, 2.5, "linear")?.position.x).toBeCloseTo(2.5);
    expect(sampleModelKeyframes(frames, 2.5, "smooth")?.position.x).toBeCloseTo(1.5625);
  });

  it("supports linear camera interpolation", () => {
    const frames = [
      { id: "a", time: 0, camera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 }, mode: "orbit" as const } },
      { id: "b", time: 10, camera: { position: { x: 10, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 }, mode: "orbit" as const } }
    ];
    expect(sampleCameraKeyframes(frames, 2.5, "linear")?.position.x).toBeCloseTo(2.5, 6);
  });

  it("uses neighboring frames for a curved spline path", () => {
    const frames = [
      { id: "a", time: 0, camera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -1 }, mode: "orbit" as const } },
      { id: "b", time: 1, camera: { position: { x: 1, y: 2, z: 0 }, target: { x: 1, y: 0, z: -1 }, mode: "orbit" as const } },
      { id: "c", time: 2, camera: { position: { x: 2, y: 0, z: 1 }, target: { x: 2, y: 0, z: -1 }, mode: "orbit" as const } },
      { id: "d", time: 3, camera: { position: { x: 4, y: 1, z: 0 }, target: { x: 3, y: 0, z: -1 }, mode: "orbit" as const } }
    ];
    const sample = sampleCameraKeyframes(frames, 1.5, "spline");
    expect(sample?.position.x).toBeCloseTo(1.4375, 5);
    expect(sample?.position.z).toBeGreaterThan(0.5);
  });

  it("scrubs an imported model clip on the same object track", () => {
    const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const frames = [
      { id: "a", modelId: "robot", time: 2, transform, animation: { clipId: "Weld", time: 0.5 } },
      { id: "b", modelId: "robot", time: 6, transform, animation: { clipId: "Weld", time: 4.5 } }
    ];
    expect(sampleModelAnimationKeyframes(frames, 4)).toEqual({ clipId: "Weld", time: 2.5 });
    expect(sampleModelAnimationKeyframes(frames, 0)).toEqual({ clipId: "Weld", time: 0.5 });
  });
});

describe("scene animation playback range", () => {
  it("falls back to the full timeline when the range is missing or degenerate", () => {
    expect(normalizeSceneAnimationPlaybackRange(undefined, 10)).toEqual({ inPoint: 0, outPoint: 10 });
    expect(normalizeSceneAnimationPlaybackRange({ inPoint: 4, outPoint: 4 }, 10)).toEqual({ inPoint: 0, outPoint: 10 });
    expect(normalizeSceneAnimationPlaybackRange({ inPoint: 6, outPoint: 2 }, 10)).toEqual({ inPoint: 0, outPoint: 10 });
    expect(normalizeSceneAnimationPlaybackRange({ inPoint: -2, outPoint: 99 }, 10)).toEqual({ inPoint: 0, outPoint: 10 });
  });

  it("keeps a valid sub-range clamped into the timeline", () => {
    expect(normalizeSceneAnimationPlaybackRange({ inPoint: 2, outPoint: 8 }, 10)).toEqual({ inPoint: 2, outPoint: 8 });
    expect(normalizeSceneAnimationPlaybackRange({ inPoint: -1, outPoint: 5 }, 10)).toEqual({ inPoint: 0, outPoint: 5 });
    expect(normalizeSceneAnimationPlaybackRange({ inPoint: 2, outPoint: 50 }, 10)).toEqual({ inPoint: 2, outPoint: 10 });
  });

  it("limits sampleSceneAnimation input to the playback range and absorbs snap overshoot", () => {
    const animation = { duration: 10, playbackRange: { inPoint: 2, outPoint: 8 }, frameRate: 30, snapToFrames: true };
    expect(sampleSceneAnimation(animation, 0)).toBe(2);
    expect(sampleSceneAnimation(animation, 30)).toBe(8);
    expect(sampleSceneAnimation(animation, 5)).toBe(5);
    // 出点 7.99 在 30fps 下吸附会溢出到 8.0，必须被拉回区间内。
    expect(sampleSceneAnimation({ ...animation, playbackRange: { inPoint: 2, outPoint: 7.99 } }, 7.99)).toBe(7.99);
  });

  it("clamps sampling to the full timeline when no range is set", () => {
    expect(sampleSceneAnimation({ duration: 4, frameRate: 30, snapToFrames: false }, 99)).toBe(4);
    expect(sampleSceneAnimation({ duration: 4, frameRate: 30, snapToFrames: false }, -3)).toBe(0);
  });

  it("advances forward playback and stops at the out point without looping", () => {
    const range = { inPoint: 2, outPoint: 8 };
    const running = advanceSceneAnimationTime({ time: 3, delta: 0.5, speed: 2, direction: 1, loop: false, pingPong: false, range });
    expect(running).toEqual({ time: 4, direction: 1, stop: false });
    const stopped = advanceSceneAnimationTime({ time: 7.9, delta: 0.2, speed: 1, direction: 1, loop: false, pingPong: false, range });
    expect(stopped.time).toBe(8);
    expect(stopped.stop).toBe(true);
  });

  it("plays in reverse and stops at the in point without looping", () => {
    const range = { inPoint: 2, outPoint: 8 };
    const running = advanceSceneAnimationTime({ time: 5, delta: 0.5, speed: 2, direction: -1, loop: false, pingPong: false, range });
    expect(running).toEqual({ time: 4, direction: -1, stop: false });
    const stopped = advanceSceneAnimationTime({ time: 2.1, delta: 0.2, speed: 1, direction: -1, loop: false, pingPong: false, range });
    expect(stopped.time).toBe(2);
    expect(stopped.stop).toBe(true);
  });

  it("wraps loop playback inside the range in both directions", () => {
    const range = { inPoint: 2, outPoint: 8 };
    expect(advanceSceneAnimationTime({ time: 7.5, delta: 1, speed: 1, direction: 1, loop: true, pingPong: false, range }).time).toBeCloseTo(2.5);
    expect(advanceSceneAnimationTime({ time: 2.5, delta: 1, speed: 1, direction: -1, loop: true, pingPong: false, range }).time).toBeCloseTo(7.5);
  });

  it("bounces ping-pong playback between the range bounds once when not looping", () => {
    const range = { inPoint: 2, outPoint: 8 };
    const bounced = advanceSceneAnimationTime({ time: 7.5, delta: 1, speed: 1, direction: 1, loop: false, pingPong: true, range });
    expect(bounced).toEqual({ time: 8, direction: -1, stop: false });
    const returned = advanceSceneAnimationTime({ time: 2.2, delta: 0.5, speed: 1, direction: -1, loop: false, pingPong: true, range });
    expect(returned).toEqual({ time: 2, direction: 1, stop: true });
  });
});
