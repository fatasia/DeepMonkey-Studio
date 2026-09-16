import { describe, expect, it } from "vitest";
import { deformationBoundsEnvelope } from "./deformationBounds.js";
import { deformationPacket } from "../renderPacketDeformation.testUtils.js";

describe("deformation bounds envelope", () => {
  it("contains weighted morph displacement", () => {
    const packet = deformationPacket("morph"), source = packet.deformation.sources[0]!, pose = packet.deformation.poses[0]!;
    const result = deformationBoundsEnvelope(source, pose, [0, 0, 0], 1);
    expect(result.radius).toBeCloseTo(1.125); expect(result.conservative).toBe(true);
  });

  it("accounts for skin translation and non-uniform scale", () => {
    const packet = deformationPacket("skin"), source = packet.deformation.sources[0]!, pose = packet.deformation.poses[0]!;
    const matrices = pose.palette!.matrices.slice(); matrices[0] = 2; matrices[12] = 3;
    const changed = { ...pose, palette: { ...pose.palette!, matrices } };
    expect(deformationBoundsEnvelope(source, changed, [0, 0, 0], 1).radius).toBeCloseTo(5);
  });

  it("rejects invalid base bounds before publishing", () => {
    const packet = deformationPacket(), source = packet.deformation.sources[0]!, pose = packet.deformation.poses[0]!;
    expect(() => deformationBoundsEnvelope(source, pose, [0, NaN, 0], 1)).toThrow();
  });

  it("contains a mirrored sphere far from the origin", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket("skin");
    pose!.palette!.matrices[0] = -1;
    const result = deformationBoundsEnvelope(source!, pose!, [100, 0, 0], 1);
    expect(Math.abs(-101 - result.center[0])).toBeLessThanOrEqual(result.radius);
  });

  it("normalizes small raw skin weights before bounding displacement", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket("skin");
    source!.skinning!.weights.fill(0.025);
    pose!.palette!.matrices[12] = 100;
    const normalized = { ...source!, skinning: { ...source!.skinning!, weightMode: "normalize" as const } };
    const result = deformationBoundsEnvelope(normalized, pose!, [0, 0, 0], 1);
    expect(Math.abs(101 - result.center[0])).toBeLessThanOrEqual(result.radius);
  });

  it("scales morph displacement before skinning", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket();
    pose!.morphWeights!.values[0] = 100;
    pose!.palette!.matrices[0] = 10;
    const result = deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1);
    expect(Math.abs(260 - result.center[0])).toBeLessThanOrEqual(result.radius);
  });

  it("bounds correlated shear columns", () => {
    const { deformation: { sources: [source], poses: [pose] } } = deformationPacket("skin");
    const matrices = pose!.palette!.matrices;
    matrices[0] = 10; matrices[4] = 10; matrices[8] = 10;
    const result = deformationBoundsEnvelope(source!, pose!, [0, 0, 0], 1);
    expect(30 / Math.sqrt(3)).toBeLessThanOrEqual(result.radius);
  });
});
