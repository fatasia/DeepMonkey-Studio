import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective } from "../webgpu/cameraMath.js";
import { CameraFrameHistory } from "../webgpu/cameraFrameHistory.js";
import { temporalAaJitter } from "./temporalAaCpu.js";
import { analyticMotion, analyticMotionField, applyInstanceRows, applyMat4, consumedPreviousPixel,
  invertMat4, mirroredMotionField, pixelRayProbe, verifyMotionField, type InstanceRows, type Mat4, type MotionSampleInput } from "./temporalMotionReference.js";

const size = 16, fov = Math.PI / 4, distance = 5;
const view = (eye: readonly number[], target: readonly number[]) => multiply(perspective(fov, 1, 0.1, 100), lookAt(eye as [number, number, number], target as [number, number, number]));
const field = (eye: readonly number[], vpCurrent: Mat4, vpPrevious: Mat4, jitterDeltaUv: readonly [number, number],
  rows?: { current?: InstanceRows; previous?: InstanceRows },
  pose?: { current: (world: readonly number[]) => readonly number[]; previous: (world: readonly number[]) => readonly number[] },
  probeDistance = distance) =>
  analyticMotionField(size, size, (px, py) => {
    const world = pixelRayProbe(invertMat4(vpCurrent), eye, px, py, size, size, probeDistance);
    const input: MotionSampleInput = { currentViewProjection: vpCurrent, previousViewProjection: vpPrevious, jitterDeltaUv, modelPoint: world,
      ...(rows?.current ? { currentRows: rows.current } : {}), ...(rows?.previous ? { previousRows: rows.previous } : {}),
      ...(pose ? { currentPose: pose.current(world), previousPose: pose.previous(world) } : {}) };
    return input;
  });
const flat = (matrix: Mat4) => new Float32Array([...matrix]);

describe("temporal motion vector reference (T07)", () => {
  it("keeps a zero motion field for a static camera and matches the shipped mirror", () => {
    const eye: readonly number[] = [0, 0, 10];
    const vp = view(eye, [0, 0, 0]);
    const expected = field(eye, vp, vp, [0, 0]);
    expect(expected.motionUv.every(value => Math.abs(value) < 1e-9)).toBe(true);
    const verification = verifyMotionField(expected, mirroredMotionField(size, size, (px, py) =>
      ({ currentViewProjection: vp, previousViewProjection: vp, jitterDeltaUv: [0, 0],
        modelPoint: pixelRayProbe(invertMat4(vp), eye, px, py, size, size, distance) })),
      1e-9, "static-camera");
    expect(verification).toMatchObject({ matched: true, mismatchedPixels: 0, maxUvError: 0 });
  });

  it.each([
    ["translation", [0.4, 0.1, 10] as const, [0, 0, 0] as const],
    ["orbit", [1.5, 0, 9.5] as const, [0, 0, 0] as const],
  ])("verifies camera %s motion per pixel against the pbrMotionCpu mirror", (_label, previousEye, target) => {
    const eye: readonly number[] = [0, 0, 10];
    const vpCurrent = view(eye, [0, 0, 0]), vpPrevious = view(previousEye, target);
    const expected = field(eye, vpCurrent, vpPrevious, [0, 0]);
    const actual = mirroredMotionField(size, size, (px, py) => ({ currentViewProjection: vpCurrent, previousViewProjection: vpPrevious,
      jitterDeltaUv: [0, 0], modelPoint: pixelRayProbe(invertMat4(vpCurrent), eye, px, py, size, size, distance) }));
    const verification = verifyMotionField(expected, actual, 1e-9, `camera-${_label}`);
    expect(verification.matched).toBe(true);
    expect(verification.maxUvError).toBeLessThan(1e-9);
    expect(expected.motionUv.some(value => Math.abs(value) > 1e-4)).toBe(true);
  });

  it("keeps pure camera rotation depth-independent at every pixel", () => {
    // Eye fixed, aim direction rotates: screen-space displacement must not depend on depth.
    const eye: readonly number[] = [0, 0, 10];
    const vpCurrent = view(eye, [0, 0, 0]), vpPrevious = view(eye, [0.8, 0.6, 0]);
    const near = field(eye, vpCurrent, vpPrevious, [0, 0], undefined, undefined, 4);
    const far = field(eye, vpCurrent, vpPrevious, [0, 0], undefined, undefined, 40);
    expect(verifyMotionField(near, far, 1e-6, "rotation-depth-invariance").matched).toBe(true);
    expect(near.motionUv.some(value => Math.abs(value) > 1e-4)).toBe(true);
  });

  it("adds jitter through the pbrFrameUniforms delta without breaking the mirror match", () => {
    const eye: readonly number[] = [0, 0, 10];
    const vpCurrent = view(eye, [0, 0, 0]), vpPrevious = view([0.4, 0.1, 10], [0, 0, 0]);
    const currentJitter = temporalAaJitter(7), previousJitter = temporalAaJitter(6);
    const jitterDeltaUv: readonly [number, number] = [(previousJitter[0] - currentJitter[0]) / size, (previousJitter[1] - currentJitter[1]) / size];
    const expected = field(eye, vpCurrent, vpPrevious, jitterDeltaUv);
    const actual = mirroredMotionField(size, size, (px, py) => ({ currentViewProjection: vpCurrent, previousViewProjection: vpPrevious,
      jitterDeltaUv, modelPoint: pixelRayProbe(invertMat4(vpCurrent), eye, px, py, size, size, distance) }));
    expect(verifyMotionField(expected, actual, 1e-9, "jitter-delta").matched).toBe(true);
    // TAA consumption closure: pixel + motion*size + jitterDeltaPixels lands on the previous pixel.
    const world = pixelRayProbe(invertMat4(vpCurrent), eye, 8.5, 8.5, size, size, distance);
    const previousClip = applyMat4(vpPrevious, world);
    const previousUv = [previousClip[0]! / previousClip[3]! * 0.5 + 0.5, previousClip[1]! / previousClip[3]! * -0.5 + 0.5];
    const landed = consumedPreviousPixel(expected, 8, 8, [previousJitter[0] - currentJitter[0], previousJitter[1] - currentJitter[1]]);
    // clipUv already maps NDC +y to the top of the image, so pixel = uv * size on both
    // axes; the 1e-5 px budget reflects the f32 quantization of the stored motion field.
    expect(Math.abs(landed[0] - previousUv[0] * size)).toBeLessThan(1e-5);
    expect(Math.abs(landed[1] - previousUv[1] * size)).toBeLessThan(1e-5);
  });

  it("verifies rigid-body instance motion and its composition with skeletal pose motion", () => {
    const eye: readonly number[] = [0, 0, 10];
    const vp = view(eye, [0, 0, 0]);
    const staticRows: InstanceRows = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    const movedRows: InstanceRows = [[1, 0, 0, 0.25], [0, 1, 0, 0.1], [0, 0, 1, -0.05]];
    const instance = field(eye, vp, vp, [0, 0], { current: movedRows, previous: staticRows });
    expect(instance.motionUv.some(value => Math.abs(value) > 1e-4)).toBe(true);
    expect(verifyMotionField(instance, mirroredMotionField(size, size, (px, py) => ({ currentViewProjection: vp, previousViewProjection: vp,
      jitterDeltaUv: [0, 0], modelPoint: pixelRayProbe(invertMat4(vp), eye, px, py, size, size, distance),
      currentRows: movedRows, previousRows: staticRows })), 1e-9, "rigid-instance").matched).toBe(true);
    // Skeletal vertex-level motion: pose offset per vertex under the moved rows must
    // compose with instance motion into the identical world-space displacement.
    const displacement = [0.25, 0.1, -0.05];
    const posed = field(eye, vp, vp, [0, 0], { current: movedRows, previous: movedRows },
      { current: world => world, previous: world => [world[0] - displacement[0], world[1] - displacement[1], world[2] - displacement[2]] });
    expect(verifyMotionField(posed, instance, 1e-9, "pose-instance-composition").matched).toBe(true);
    const staticWorld = applyInstanceRows(staticRows, [0, 0, 0]), movedWorld = applyInstanceRows(movedRows, staticWorld);
    const clipStatic = applyMat4(vp, staticWorld), clipMoved = applyMat4(vp, movedWorld);
    // Motion points from the current toward the previous position; NDC-to-UV scales by 0.5.
    const expectedUvDelta = [(clipStatic[0]! / clipStatic[3]! - clipMoved[0]! / clipMoved[3]!) * 0.5,
      (clipMoved[1]! / clipMoved[3]! - clipStatic[1]! / clipStatic[3]!) * 0.5];
    const motion = analyticMotion({ currentViewProjection: vp, previousViewProjection: vp, jitterDeltaUv: [0, 0],
      modelPoint: [0, 0, 0], currentRows: movedRows, previousRows: staticRows });
    expect(motion[0]).toBeCloseTo(expectedUvDelta[0], 12);
    expect(motion[1]).toBeCloseTo(expectedUvDelta[1], 12);
  });

  it("marks camera cuts through CameraFrameHistory and zeroes the cut-frame field", () => {
    const history = new CameraFrameHistory();
    const initial = view([0, 0, 10], [0, 0, 0]);
    history.advance({ eye: [0, 0, 10], target: [0, 0, 0], extent: 10, width: size, height: size,
      viewProjection: initial, jitter: [0, 0] });
    const slow = view([0, 0, 10], [0, 0.01, 0]);
    const slowResult = history.advance({ eye: [0, 0, 10], target: [0, 0.01, 0], extent: 10, width: size, height: size,
      viewProjection: slow, jitter: [0, 0] });
    expect(slowResult.cameraCut).toBe(false);
    const cutState = { eye: [0, 0, 10] as [number, number, number], target: [0, 6, 0] as [number, number, number], extent: 10,
      width: size, height: size, viewProjection: view([0, 0, 10], [0, 6, 0]), jitter: [0, 0] as const };
    const cut = history.beginFrame(cutState);
    expect(cut.cameraCut).toBe(true);
    // Cut frames publish previous == current, so the vertex motion of every pixel is zero.
    const zeroField = field(cutState.eye, cutState.viewProjection, cut.previousViewProjection, [0, 0]);
    expect(zeroField.motionUv.every(value => value === 0)).toBe(true);
    history.commitFrame(cut);
    // Force-cut parity: the explicit flag produces the same previous == current contract.
    const forced = history.beginFrame({ ...cutState, forceCut: true });
    expect(forced.cameraCut).toBe(true);
    expect(Array.from(forced.previousViewProjection)).toEqual(Array.from(cutState.viewProjection));
    history.commitFrame(forced);
  });

  it("packs the pbrFrameUniforms jitter delta and keeps TAA consumption inside the previous frame", () => {
    const eye: readonly number[] = [0, 0, 10];
    const vpCurrent = view(eye, [0, 0, 0]), vpPrevious = view([0.4, 0.1, 10], [0, 0, 0]);
    const currentJitter = temporalAaJitter(3), previousJitter = temporalAaJitter(2);
    const jitterField = field(eye, vpCurrent, vpPrevious,
      [(previousJitter[0] - currentJitter[0]) / size, (previousJitter[1] - currentJitter[1]) / size]);
    // Every reprojected sample must stay a finite position on the previous image plane.
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const landed = consumedPreviousPixel(jitterField, x, y, [previousJitter[0] - currentJitter[0], previousJitter[1] - currentJitter[1]]);
      expect(Number.isFinite(landed[0]) && Number.isFinite(landed[1])).toBe(true);
      expect(landed[0]).toBeGreaterThan(-2);
      expect(landed[1]).toBeGreaterThan(-2);
    }
  });
});
