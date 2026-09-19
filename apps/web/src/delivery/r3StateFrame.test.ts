import { describe, expect, it } from "vitest";

import {
  R3_STATE_FRAME_CONTRACT,
  canonicalR3StateFrame,
  clipFieldFromClippingState,
  clippingStateForContract,
  parseR3StateOps,
} from "./r3StateFrame";

// The frozen sequence shared with the Rust consumer
// (packages/deep-engine-native/src/runtime_package/r3_state.rs): the expected
// strings below are the cross-end golden; both ends must produce them exactly.
const frozenOps = {
  schema: "deep-monkey.r3-state-ops",
  schemaVersion: 1,
  id: "r3-state-replay",
  packageHash: "a".repeat(64),
  steps: [
    { atMs: 0, op: { kind: "clip-enable", axis: "z", inverted: false, offset: 0.125 } },
    { atMs: 100, op: { kind: "select", targetId: "pump" } },
    { atMs: 200, op: { kind: "clip-move", offset: -1.25 } },
    { atMs: 300, op: { kind: "box-enable", box: { min: [-1, -2, -1.5], max: [1, 2, 1.5] } } },
    { atMs: 400, op: { kind: "clip-disable" } },
    { atMs: 500, op: { kind: "clear-selection" } },
  ],
};

const revisions = (timeMs: number) => (timeMs >= 750 ? [1, 2] : timeMs >= 250 ? [1] : []);

describe("r3StateFrame", () => {
  it("produces the cross-end golden frames for the frozen sequence", () => {
    const ops = parseR3StateOps(structuredClone(frozenOps));
    const expected = [
      `${R3_STATE_FRAME_CONTRACT}|i=0|t=0|clip=axis:z,dir=1,off=0.125000|sel=-|events=`,
      `${R3_STATE_FRAME_CONTRACT}|i=1|t=100|clip=axis:z,dir=1,off=0.125000|sel=pump|events=`,
      `${R3_STATE_FRAME_CONTRACT}|i=2|t=200|clip=axis:z,dir=1,off=-1.250000|sel=pump|events=`,
      `${R3_STATE_FRAME_CONTRACT}|i=3|t=300|clip=box:min=-1.000000,-2.000000,-1.500000,max=1.000000,2.000000,1.500000|sel=pump|events=1`,
      `${R3_STATE_FRAME_CONTRACT}|i=4|t=400|clip=off|sel=pump|events=1`,
      `${R3_STATE_FRAME_CONTRACT}|i=5|t=500|clip=off|sel=-|events=1`,
    ];
    ops.steps.forEach((_, index) => {
      expect(canonicalR3StateFrame(ops, index, revisions(ops.steps[index]!.atMs)).canonical).toBe(expected[index]);
    });
  });

  it("normalizes -0 and keeps applied readbacks byte-identical with the contract", () => {
    const ops = parseR3StateOps({
      ...frozenOps,
      steps: [{ atMs: 0, op: { kind: "clip-enable", axis: "x", inverted: true, offset: -0 } }],
    });
    const frame = canonicalR3StateFrame(ops, 0, []);
    expect(frame.canonical).toBe(`${R3_STATE_FRAME_CONTRACT}|i=0|t=0|clip=axis:x,dir=-1,off=0.000000|sel=-|events=`);
    // An f32 round-trip of the applied value must quantize back onto the same frame.
    const f32Applied = Math.fround(frame.clip.kind === "axis" ? frame.clip.offset : 0);
    expect(clipFieldFromClippingState(clippingStateForContract({ kind: "axis", axis: "x", inverted: true, offset: f32Applied }))).toBe("axis:x,dir=-1,off=0.000000");
  });

  it("rejects off-grid floats, out-of-bound coordinates, and unknown shapes", () => {
    expect(() => parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "clip-enable", axis: "z", inverted: false, offset: 0.1005 } }] }))
      .toThrow(/must sit on the 0.001 grid/);
    expect(() => parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "clip-enable", axis: "z", inverted: false, offset: 1500 } }] }))
      .toThrow(/contract bound/);
    expect(() => parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "clip-enable", axis: "z", inverted: false } }] }))
      .toThrow(/requires offset/);
    expect(() => parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "select", targetId: "-pump" } }] }))
      .toThrow(/targetId/);
    expect(() => parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "select", targetId: "pump" }, extra: 1 }] }))
      .toThrow(/unknown field "extra"/);
    expect(() => parseR3StateOps({ ...frozenOps, steps: [{ atMs: 200, op: { kind: "clip-move", offset: 1 } }, { atMs: 100, op: { kind: "clear-selection" } }] }))
      .toThrow(/must not move backwards/);
  });

  it("accepts equal atMs as a legal non-decreasing step", () => {
    const ops = parseR3StateOps({
      ...frozenOps,
      steps: [
        { atMs: 100, op: { kind: "clip-enable", axis: "y", inverted: false, offset: 2.5 } },
        { atMs: 100, op: { kind: "clear-selection" } },
      ],
    });
    expect(canonicalR3StateFrame(ops, 1, []).canonical).toBe(`${R3_STATE_FRAME_CONTRACT}|i=1|t=100|clip=axis:y,dir=1,off=2.500000|sel=-|events=`);
  });

  it("fails clip-move against a disabled or box clip instead of guessing", () => {
    const ops = parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "clip-move", offset: 1 } }] });
    expect(() => canonicalR3StateFrame(ops, 0, [])).toThrow(/requires an enabled axis clip/);
    const boxed = parseR3StateOps({ ...frozenOps, steps: [{ atMs: 0, op: { kind: "box-enable", box: { min: [0, 0, 0], max: [1, 1, 1] } } }, { atMs: 10, op: { kind: "clip-move", offset: 1 } }] });
    expect(() => canonicalR3StateFrame(boxed, 1, [])).toThrow(/requires an enabled axis clip/);
  });

  it("rejects face readbacks and box readbacks without bounds", () => {
    expect(() => clipFieldFromClippingState({ enabled: true, mode: "face", axis: "x", offset: 0, inverted: false }))
      .toThrow(/face clipping/);
    expect(() => clipFieldFromClippingState({ enabled: true, mode: "box", axis: "x", offset: 0, inverted: false }))
      .toThrow(/missing box bounds/);
  });
});
