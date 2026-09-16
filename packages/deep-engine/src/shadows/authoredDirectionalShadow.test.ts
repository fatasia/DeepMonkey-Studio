import { describe, expect, it } from "vitest";
import { snapshotAuthoredShadow, planAuthoredShadow, packAuthoredShadow } from "./authoredDirectionalShadow.js";
import { sceneShader } from "../webgpu/pbrShader.js";

const source = { viewProjection: [0.2, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -1 / 299.9, 0, 0, 0, -0.1 / 299.9, 1],
  mapSize: 1024, bias: -0.0001, normalBias: 0.015, intensity: 0.38, radius: 3 };
describe("authored directional shadow", () => {
  it("uses the exact authored orthographic matrix, bounds and layer zero", () => {
    const snapshot = snapshotAuthoredShadow(source), plan = planAuthoredShadow(snapshot, [0, 0, -1]);
    const slice = plan.cascades[0]!;
    expect(plan.cascades).toHaveLength(1); expect(slice.index).toBe(0);
    expect(slice.viewProjection).toEqual(new Float32Array(source.viewProjection));
    expect(slice.center[2]).toBeCloseTo(-150.05, 5);
    expect(slice.radius).toBe(10); expect(slice.texelWorldSize).toBe(20 / 1024);
    expect(Math.min(...slice.corners.map(p => p[0]))).toBeCloseTo(-5);
    expect(Math.max(...slice.corners.map(p => p[1]))).toBeCloseTo(10);
    expect(Math.min(...slice.corners.map(p => p[2]))).toBeCloseTo(-300);
    expect(Math.max(...slice.corners.map(p => p[2]))).toBeCloseTo(-0.1);
    expect(Object.isFrozen(snapshot.viewProjection)).toBe(true);
  });
  it("packs signed compare bias, world normal bias, intensity and PCF radius without growing ABI", () => {
    const plan = planAuthoredShadow(source, [0, 0, -1]), data = packAuthoredShadow(plan, source, 800);
    expect(data).toHaveLength(156); expect(data[155]).toBe(2);
    expect(data[153]).toBeCloseTo(-0.0001); expect(data[148]).toBeCloseTo(0.015);
    expect(data[149]).toBeCloseTo(0.38); expect(data[150]).toBe(3); expect(data[151]).toBe(800);
    expect(data[154]).toBe(1 / 1024);
  });
  it.each([{ bias: NaN }, { bias: 0.11 }, { normalBias: -1 }, { intensity: 1.1 },
    { radius: Infinity }, { mapSize: 0 }])("rejects invalid sampling %j", changes => {
    expect(() => snapshotAuthoredShadow({ ...source, ...changes })).toThrow("parameters");
  });
  it("rejects nonorthographic, singular, sheared and nonfinite matrices", () => {
    for (const [offset, value] of [[3, 1], [0, 0], [4, 0.1], [12, Infinity]]) {
      const viewProjection = [...source.viewProjection]; viewProjection[offset!] = value!;
      expect(() => snapshotAuthoredShadow({ ...source, viewProjection })).toThrow();
    }
  });
  it("takes bias coordinates from unperturbed vertex normals and samples five Vogel taps", () => {
    expect(sceneShader.match(/out.authorShadow = deepAuthorShadowCoordinate\(out.world, out.normal\)/g)).toHaveLength(5);
    expect(sceneShader).toContain("world + normal * deepCascade.texelWorld1.x");
    expect(sceneShader).toContain("let depth = ndc.z + deepCascade.params.y");
    expect(sceneShader).toContain("index < 5u"); expect(sceneShader).toContain("2.399963229728653");
    expect(sceneShader).toContain("mix(1.0, visibility * 0.2, deepCascade.texelWorld1.y)");
  });
});
