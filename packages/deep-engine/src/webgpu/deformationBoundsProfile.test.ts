import { describe, expect, it } from "vitest";
import { deformationBoundsEnvelope, prepareDeformationBounds } from "./deformationBounds.js";
import { deformationPacket } from "../renderPacketDeformation.testUtils.js";

describe("deformation bounds preparation", () => {
  it("does not revisit vertex streams in explicit or cached hot queries", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket();
    const prepared = prepareDeformationBounds(source!);
    const expected = deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1);
    Object.defineProperty(source!.skinning, "weights", { get() { throw new Error("hot vertex scan"); } });
    Object.defineProperty(source!.morph!.primitive.targets[0], "positionDeltas", { get() { throw new Error("hot morph scan"); } });
    expect(deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1, prepared)).toEqual(expected);
    expect(deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1)).toEqual(expected);
  });

  it("rejects explicit stale profiles and prepares replacements for revised sources", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket("morph");
    const profile = prepareDeformationBounds(source!);
    const before = deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1);
    source!.morph!.primitive.targets[0]!.positionDeltas!.fill(2);
    Object.assign(source!, { revision: source!.revision + 1 });
    expect(() => deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1, profile)).toThrow("stale");
    expect(deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1).radius).toBeGreaterThan(before.radius);
  });

  it("contains preserve weight sums below and above one around an offset center", () => {
    for (const weight of [0.025, 0.5, 2]) {
      const { deformation: { sources: [source], poses: [pose] } } = deformationPacket("skin");
      source!.skinning!.weights.fill(weight);
      const result = deformationBoundsEnvelope(source!, pose!, [100, 0, 0], 1);
      expect(Math.abs(101 * weight * 4 - 100)).toBeLessThanOrEqual(result.radius);
      expect(Math.abs(99 * weight * 4 - 100)).toBeLessThanOrEqual(result.radius);
    }
  });

  it("rejects malformed cold sources, mismatched hot poses and overflowing bounds", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket();
    const profile = prepareDeformationBounds(source!);
    expect(() => deformationBoundsEnvelope(source!, { ...pose!, source: "other" }, [0, 0, 0], 1, profile)).toThrow("match");
    expect(() => deformationBoundsEnvelope(source!, { ...pose!, palette: undefined }, [0, 0, 0], 1, profile)).toThrow("match");
    pose!.palette!.matrices[0] = NaN;
    expect(() => deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1, profile)).toThrow("finite");
    pose!.palette!.matrices[0] = 1e30;
    expect(() => deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1e30, profile)).toThrow("range");
    source!.skinning!.weights[0] = -1;
    expect(() => prepareDeformationBounds(source!)).toThrow();
  });

  it("accounts for center quantization in float32 culling storage", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket("skin");
    const center = [100_000_003, 0, 0] as const;
    const result = deformationBoundsEnvelope(source!, pose!, center, 0.01);
    expect(Math.abs(center[0] - Math.fround(result.center[0])) + 0.01).toBeLessThan(result.radius);
  });

  it("contains independently evaluated multi-joint morph/skin combinations", () => {
    let seed = 1842;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (const weightMode of ["normalize", "preserve"] as const) for (let trial = 0; trial < 40; trial++) {
      const { deformation: { sources: [original], poses: [pose] } } = deformationPacket();
      const skin = { ...original!.skinning!, weightMode };
      const source = { ...original!, skinning: skin };
      for (let lane = 0; lane < skin.weights.length; lane++) {
        skin.weights[lane] = random() * (trial % 2 ? 3 : 0.01);
        skin.joints[lane] = lane % 2;
      }
      const matrices = new Float32Array(32);
      for (let joint = 0; joint < 2; joint++) {
        const offset = joint * 16;
        for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) matrices[offset + col * 4 + row] = random() * 6 - 3;
        matrices[offset + 12] = random() * 40 - 20;
        matrices[offset + 13] = random() * 40 - 20;
        matrices[offset + 14] = random() * 40 - 20;
        matrices[offset + 15] = 1;
      }
      pose!.morphWeights!.values[0] = random() * 20 - 10;
      const current = { ...pose!, palette: { revision: 1, matrices } };
      const result = deformationBoundsEnvelope(source, current, [0.5, 0.5, 0], Math.SQRT1_2);
      for (let vertex = 0; vertex < 3; vertex++) {
        const input = Array.from(skin.positions.slice(vertex * 3, vertex * 3 + 3));
        const deltas = source.morph!.primitive.targets[0]!.positionDeltas!;
        for (let axis = 0; axis < 3; axis++) input[axis]! += deltas[vertex * 3 + axis]! * current.morphWeights!.values[0]!;
        let sum = 0;
        for (let lane = 0; lane < 4; lane++) sum += skin.weights[vertex * 4 + lane]!;
        const output = [0, 0, 0];
        for (let lane = 0; lane < 4; lane++) {
          const joint = skin.joints[vertex * 4 + lane]! * 16;
          const weight = Math.fround(skin.weights[vertex * 4 + lane]! / (weightMode === "normalize" ? sum : 1));
          for (let axis = 0; axis < 3; axis++) output[axis]! += weight * (matrices[joint + axis]! * input[0]!
            + matrices[joint + 4 + axis]! * input[1]! + matrices[joint + 8 + axis]! * input[2]! + matrices[joint + 12 + axis]!);
        }
        expect(Math.hypot(output[0]! - result.center[0], output[1]! - result.center[1], output[2]! - result.center[2]))
          .toBeLessThanOrEqual(result.radius);
      }
    }
  });
});
