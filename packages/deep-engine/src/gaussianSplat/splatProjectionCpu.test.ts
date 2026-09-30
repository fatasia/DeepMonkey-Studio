import { expect, it } from "vitest";
import { projectSplatCpu, projectedSplatAlpha } from "./splatProjectionCpu.js";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frame = { viewMatrix: identity, viewProjectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, 0, 0],
  cameraPosition: [0, 0, 0] as const, viewportPixels: [1920, 1080] as const, focalPixels: [800, 600] as const, splatCount: 1 };
it("projects an anisotropic rotated covariance by rows, including screen xy coupling", () => {
  const record = [0, 0, -2, .8, .2, .05, .01, 0, 0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8), 1, 0, 0, .8];
  const result = projectSplatCpu(record, frame)!;
  expect(result.centerPixels).toEqual([960, 540]);
  expect(result.covariance[0]).toBeCloseTo(3400.3, 6);
  expect(result.covariance[1]).toBeCloseTo(2250, 6);
  expect(result.covariance[2]).toBeCloseTo(1912.8, 6);
  expect(projectedSplatAlpha(result, 960, 540)).toBe(.8);
  expect(projectedSplatAlpha(result, 960 + Math.sqrt(3400.3), 540)).toBeGreaterThan(0);
  record[2] = 0; expect(projectSplatCpu(record, frame)).toBeUndefined();
});
it("uses exp(-one-half radius squared) for the sigma coordinate contract", () => {
  const sample = { centerPixels: [10, 10] as const, depth: .5, covariance: [4, 0, 9] as const, alpha: .8 };
  expect(projectedSplatAlpha(sample, 12, 10)).toBeCloseTo(.8 * Math.exp(-.5), 12);
  expect(projectedSplatAlpha(sample, 14, 10)).toBeCloseTo(.8 * Math.exp(-2), 12);
  expect(projectedSplatAlpha(sample, 30, 30)).toBe(0);
});
