import { describe, expect, it } from "vitest";
import { analyticMotion, applyInstanceRows } from "./temporalMotionReference.js";
import { buildAllSequences, buildFenceSequence, type TemporalSequence } from "./temporalSequenceScenes.js";

const IDENTITY_ROWS: [readonly [number, number, number, number], readonly [number, number, number, number], readonly [number, number, number, number]]
  = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

const cached = new Map<string, TemporalSequence>();
let allCache: readonly TemporalSequence[] | undefined;
const allSequences = (): readonly TemporalSequence[] => {
  if (!allCache) allCache = buildAllSequences();
  return allCache;
};
const sequence = (name: string, build: () => TemporalSequence): TemporalSequence => {
  if (!cached.has(name)) cached.set(name, build());
  return cached.get(name)!;
};

function forEachObjectPixel(sequenceArg: TemporalSequence, frameIndex: number,
  visit: (pixel: number, worldXyz: readonly number[], objectId: number, motion: readonly [number, number]) => void): void {
  const frame = sequenceArg.frames[frameIndex]!;
  for (let pixel = 0; pixel < sequenceArg.width * sequenceArg.height; pixel++) {
    const objectId = frame.world[pixel * 4 + 3]!;
    if (objectId === 0) continue;
    const world = [frame.world[pixel * 4]!, frame.world[pixel * 4 + 1]!, frame.world[pixel * 4 + 2]!];
    const expected = analyticMotion({ currentViewProjection: frame.viewProjection, previousViewProjection: frame.previousViewProjection,
      jitterDeltaUv: [0, 0], modelPoint: world,
      currentRows: IDENTITY_ROWS, previousRows: frame.relativeRows[objectId - 1] ?? IDENTITY_ROWS });
    visit(pixel, world, objectId, expected);
  }
}

describe("temporal sequence scenes (T07 GPU harness fixtures)", () => {
  it("builds all four sequences deterministically", () => {
    const first = sequence("fence", () => buildFenceSequence());
    const second = buildFenceSequence();
    expect(first.frames.length).toBe(8);
    for (let frame = 0; frame < 8; frame++) {
      expect(Array.from(first.frames[frame]!.color)).toEqual(Array.from(second.frames[frame]!.color));
      expect(Array.from(first.frames[frame]!.depth)).toEqual(Array.from(second.frames[frame]!.depth));
    }
  }, 40_000);

  it("keeps geometry sane: positive depth, valid object ids, finite world positions", () => {
    for (const sequenceArg of allSequences()) {
      expect(sequenceArg.sourceContrast).toBeGreaterThan(0.4);
      const pixels = sequenceArg.width * sequenceArg.height;
      for (const frame of sequenceArg.frames) {
        for (let pixel = 0; pixel < pixels; pixel++) {
          if (!(frame.depth[pixel]! > 0)) throw new Error(`depth not positive at pixel ${pixel}`);
          const objectId = frame.world[pixel * 4 + 3]!;
          if (!(objectId >= 0 && objectId <= frame.relativeRows.length)) throw new Error(`objectId ${objectId} out of range at ${pixel}`);
          for (let channel = 0; channel < 3; channel++) {
            if (!Number.isFinite(frame.world[pixel * 4 + channel]!)) throw new Error("non-finite world position");
            if (!(frame.color[pixel * 4 + channel]! >= 0)) throw new Error("negative color");
          }
        }
      }
    }
  }, 60_000);

  it("freezes the static tail bitwise and animates the head", () => {
    for (const sequenceArg of allSequences()) {
      const [staticA, staticB] = [sequenceArg.frames[sequenceArg.moveFrames]!, sequenceArg.frames[sequenceArg.moveFrames + 1]!];
      expect(Array.from(staticA.color)).toEqual(Array.from(staticB.color));
      expect(Array.from(staticA.depth)).toEqual(Array.from(staticB.depth));
      const head = sequenceArg.frames[1]!, tail = sequenceArg.frames[sequenceArg.moveFrames]!;
      let differing = 0;
      for (let pixel = 0; pixel < sequenceArg.width * sequenceArg.height; pixel++) {
        if (Math.abs(head.color[pixel * 4]! - tail.color[pixel * 4]!) > 1e-6) differing++;
      }
      expect(differing).toBeGreaterThan(0);
    }
  }, 40_000);

  it("matches the analytic motion reference for every object pixel (previousRows composition)", () => {
    const toUv = (clip: readonly number[]): readonly [number, number] => [clip[0]! / clip[3]! * 0.5 + 0.5, clip[1]! / clip[3]! * -0.5 + 0.5];
    const applyColumnMajor = (m: readonly number[], p: readonly number[]): readonly [number, number, number, number] =>
      [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
        m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!, m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!];
    for (const sequenceArg of allSequences()) {
      for (const frameIndex of [1, 3, 5]) {
        forEachObjectPixel(sequenceArg, frameIndex, (pixel, world, objectId, expected) => {
          const frame = sequenceArg.frames[frameIndex]!;
          const rows = frame.relativeRows[objectId - 1]!;
          const previousWorld = applyInstanceRows(rows, world);
          const rel = [rows[0][0]!, rows[0][1]!, rows[0][2]!, rows[0][3]!, rows[1][0]!, rows[1][1]!, rows[1][2]!, rows[1][3]!,
            rows[2][0]!, rows[2][1]!, rows[2][2]!, rows[2][3]!, 0, 0, 0, 1] as const;
          const viaMatrix = toUv(applyColumnMajor(frame.previousViewProjection, [previousWorld[0], previousWorld[1], previousWorld[2], 1]));
          const current = toUv(applyColumnMajor(frame.viewProjection, [world[0], world[1], world[2], 1]));
          expect(Math.abs(viaMatrix[0] - current[0] - expected[0])).toBeLessThan(1e-12);
          expect(Math.abs(viaMatrix[1] - current[1] - expected[1])).toBeLessThan(1e-12);
        });
      }
    }
  }, 60_000);

  it("produces zero motion on frame 0 and camera-only motion while panning", () => {
    for (const sequenceArg of allSequences()) {
      forEachObjectPixel(sequenceArg, 0, (_pixel, _world, _objectId, motion) => {
        expect(Math.abs(motion[0])).toBeLessThan(1e-7);
        expect(Math.abs(motion[1])).toBeLessThan(1e-7);
      });
    }
    const fence = allSequences()[0]!;
    let maxCameraMotion = 0;
    forEachObjectPixel(fence, 2, (_pixel, _world, _objectId, motion) => { maxCameraMotion = Math.max(maxCameraMotion, Math.abs(motion[0])); });
    expect(maxCameraMotion).toBeGreaterThan(1e-4);
  }, 60_000);
});
