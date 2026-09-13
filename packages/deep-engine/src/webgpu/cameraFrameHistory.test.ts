import { describe, expect, it } from "vitest";
import { CameraFrameHistory, jitterViewProjection } from "./cameraFrameHistory.js";

const matrix = (offset = 0): Float32Array => new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  offset, 0, 0, 1,
]);
const frame = (overrides: Partial<Parameters<CameraFrameHistory["advance"]>[0]> = {}) => ({
  eye: [0, 0, 10] as const,
  target: [0, 0, 0] as const,
  extent: 10,
  width: 1280,
  height: 720,
  viewProjection: matrix(),
  jitter: [0, 0] as const,
  ...overrides,
});

describe("camera frame history", () => {
  it("publishes current as previous on the first frame and advances exact submitted history", () => {
    const history = new CameraFrameHistory();
    const first = history.advance(frame());
    expect(first).toMatchObject({ revision: 0, cameraCut: true });
    expect(first.previousViewProjection).toEqual(matrix());

    const secondMatrix = matrix(0.02);
    const second = history.advance(frame({ eye: [0.05, 0, 10], viewProjection: secondMatrix, jitter: [0.25, -0.25] }));
    expect(second).toMatchObject({ revision: 1, cameraCut: false });
    expect(second.previousViewProjection).toEqual(matrix());
    expect(second.previousViewProjection).not.toBe(first.previousViewProjection);
    expect(second).toMatchObject({ currentJitter: [0.25, -0.25], previousJitter: [0, 0] });
  });

  it("invalidates history on resize, explicit cuts, large jumps, and zoom discontinuities", () => {
    const cases = [
      { width: 640 },
      { forceCut: true },
      { eye: [8, 0, 10] as const },
      { target: [8, 0, 0] as const },
      { extent: 20 },
    ];
    for (const changed of cases) {
      const history = new CameraFrameHistory(); history.advance(frame());
      const current = matrix(0.5), result = history.advance(frame({ ...changed, viewProjection: current }));
      expect(result.cameraCut).toBe(true);
      expect(result.previousViewProjection).toEqual(current);
    }
  });

  it("resets revision and fails closed on malformed frame state", () => {
    const history = new CameraFrameHistory(); history.advance(frame()); history.reset();
    expect(history.advance(frame())).toMatchObject({ revision: 0, cameraCut: true });
    expect(() => history.advance(frame({ width: 0 }))).toThrow("dimensions");
    expect(() => history.advance(frame({ extent: Number.NaN }))).toThrow("view");
    expect(() => history.advance(frame({ viewProjection: new Float32Array(15) }))).toThrow("16 finite");
    expect(() => history.advance(frame({ jitter: [0.6, 0] }))).toThrow("half-pixel");
  });

  it("publishes only a successfully submitted frame and keeps the prior camera after cancellation", () => {
    const history = new CameraFrameHistory();
    const first = history.beginFrame(frame());
    expect(() => history.beginFrame(frame())).toThrow("already active");
    history.commitFrame(first);
    const failed = history.beginFrame(frame({ eye: [0.1, 0, 10], viewProjection: matrix(0.1) }));
    history.cancelFrame(failed);
    const retry = history.beginFrame(frame({ eye: [0.2, 0, 10], viewProjection: matrix(0.2) }));
    expect(retry.revision).toBe(2);
    expect(retry.previousViewProjection).toEqual(matrix());
    history.cancelFrame(retry);
    expect(() => history.commitFrame(retry)).toThrow("not active");
  });

  it("injects pixel jitter into clip x/y while preserving z/w", () => {
    const result = jitterViewProjection(matrix(), [0.5, 0.25], 100, 50);
    expect(result[12]).toBeCloseTo(0.01, 8);
    expect(result[13]).toBeCloseTo(-0.01, 8);
    expect(result[14]).toBe(0); expect(result[15]).toBe(1);
  });
});
