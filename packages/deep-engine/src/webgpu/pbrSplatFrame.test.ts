import { expect, it } from "vitest";
import { pbrSplatFrame } from "./pbrSplatFrame.js";
it("preserves mesh jitter and converts camera-relative matrices for world-space Gaussian records", () => {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1];
  const absolute = pbrSplatFrame(matrix, matrix, [10, 20, 30], 1920, 1080, Math.PI / 2, .2, [10, 20, 30]);
  expect(Array.from(absolute.viewMatrix).slice(12)).toEqual([-8, -17, -26, 1]);
  expect(absolute.viewProjectionMatrix).toEqual(absolute.viewMatrix);
  expect(absolute.focalPixels[0]).toBeCloseTo(540); expect(absolute.near).toBe(.2);
  expect(matrix.slice(12)).toEqual([2, 3, 4, 1]);
  expect(pbrSplatFrame(matrix, matrix, [0, 0, 0], 1, 1, 1, .1).viewMatrix).toBe(matrix);
});
