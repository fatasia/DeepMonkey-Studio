import { describe, expect, it } from "vitest";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { Matrix4, Vector3 } from "three";
import { createSceneGeometryPrecisionValidator } from "./sceneGeometryPrecision";

type Geometry = RenderPacket["geometries"][number];
function geometry(x: number): Geometry {
  return { id: "shared-id", revision: 1, vertices: new Float32Array([x, 0, 0, 0, 0, 1, x, 1, 0, 0, 0, 1, x, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}
describe("geometry transform precision budget", () => {
  it("rejects large vertices amplified by quantized scale despite zero translation", () => {
    expect(() => createSceneGeometryPrecisionValidator()(geometry(1e8), new Matrix4().makeScale(1.0000001, 1, 1).elements, "model"))
      .toThrow(/model.geometry\[shared-id\].*无法在当前局部坐标精度预算内验证.*保守误差上界/);
  });
  it("rejects accumulated rotation error away from the geometry center", () => {
    expect(() => createSceneGeometryPrecisionValidator()(geometry(1e6), new Matrix4().makeRotationZ(Math.PI / 4).elements, "rotated"))
      .toThrow("无法在当前局部坐标精度预算内验证");
  });
  it("accepts ordinary rotations/scales and a large geometry scaled into a small local range", () => {
    const verify = createSceneGeometryPrecisionValidator();
    verify(geometry(1), new Matrix4().makeRotationZ(0.4).scale(new Vector3(2, 3, 4)).elements, "ordinary");
    verify(geometry(1e8), new Matrix4().makeScale(1e-8, 1e-8, 1e-8).elements, "small");
  });
  it("isolates cached geometry objects even when their IDs match", () => {
    const verify = createSceneGeometryPrecisionValidator(), matrix = new Matrix4().elements;
    verify(geometry(1), matrix, "first");
    expect(() => verify(geometry(1e8), matrix, "different-content")).toThrow("different-content");
  });
  it("checks each instance while reading shared vertex bounds once", () => {
    const source = geometry(1); let reads = 0;
    const vertices = source.vertices;
    Object.defineProperty(source, "vertices", { get() { reads++; return vertices; } });
    const verify = createSceneGeometryPrecisionValidator(); verify(source, new Matrix4().elements, "first");
    const afterFirst = reads; verify(source, new Matrix4().makeScale(2, 2, 2).elements, "second");
    expect(reads).toBe(afterFirst);
    expect(() => verify(source, new Matrix4().makeScale(1e8, 1e8, 1e8).elements, "third")).toThrow("third");
  });
  it("does not promise exactness for large integer products merely because this operation rounds exactly", () => {
    expect(Math.fround(1e8)).toBe(1e8);
    expect(() => createSceneGeometryPrecisionValidator()(geometry(1e8), new Matrix4().elements, "exact-integer"))
      .toThrow("保守误差上界");
  });
  it("uses drawn vertices rather than untrusted declared bounds or unused buffer data", () => {
    const base = geometry(1);
    const source = { ...base, min: [0, 0, 0], max: [0, 0, 0], vertices: new Float32Array([...base.vertices, 1e8, 0, 0, 0, 0, 1]) };
    createSceneGeometryPrecisionValidator()(source, new Matrix4().elements, "unused");
    const used = { ...source, indices: new Uint32Array([0, 1, 3]) };
    expect(() => createSceneGeometryPrecisionValidator()(used, new Matrix4().elements, "used")).toThrow("used");
  });
  it("rejects potential subnormal input flushing amplified by a large coefficient", () => {
    expect(() => createSceneGeometryPrecisionValidator()(geometry(1e-40), new Matrix4().makeScale(1e38, 1, 1).elements, "ftz"))
      .toThrow("ftz");
  });
  it.each([NaN, Infinity, 1e39])("rejects invalid or overflowing matrix value %s", value => {
    const matrix = new Matrix4().elements; matrix[0] = value;
    expect(() => createSceneGeometryPrecisionValidator()(geometry(1), matrix, "invalid")).toThrow();
  });
});
