import { describe, expect, it } from "vitest";
import { normalizeAnimationFrameRate, sampleCameraKeyframes, sampleModelAnimationKeyframes, sampleModelKeyframes, snapAnimationTime } from "./timeline";

describe("timeline sampling", () => {
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
