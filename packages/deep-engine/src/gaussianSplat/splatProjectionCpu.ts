import type { SplatFrameUniforms } from "./splatGpuResources.js";
import { SPLAT_ALPHA_CUTOFF, SPLAT_COVARIANCE_PAD_PX2 } from "./splatGpuResources.js";

export interface ProjectedSplat {
  readonly centerPixels: readonly [number, number];
  readonly depth: number;
  /** Screen covariance xx, xy, yy, in squared pixels. */
  readonly covariance: readonly [number, number, number];
  readonly alpha: number;
}
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
function multiply(a: readonly number[][], b: readonly number[][]): number[][] {
  return a.map(row => b[0]!.map((_, column) => dot(row, b.map(item => item[column]!))));
}
const transpose = (a: readonly number[][]) => a[0]!.map((_, column) => a.map(row => row[column]!));

/** Independent double-precision covariance reference, using world covariance before projection. */
export function projectSplatCpu(record: ArrayLike<number>, frame: SplatFrameUniforms): ProjectedSplat | undefined {
  const point = [record[0]!, record[1]!, record[2]!, 1];
  const transform = (matrix: ArrayLike<number>) => [0, 1, 2, 3].map(row => dot(point, [matrix[row]!, matrix[row + 4]!, matrix[row + 8]!, matrix[row + 12]!]));
  const position = transform(frame.viewMatrix), clip = transform(frame.viewProjectionMatrix);
  if (position[2]! >= -(frame.near ?? .1) || clip[3]! <= 0) return undefined;
  const norm = Math.hypot(record[8]!, record[9]!, record[10]!, record[11]!);
  const x = record[8]! / norm, y = record[9]! / norm, z = record[10]! / norm, w = record[11]! / norm;
  const rotation = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  const covarianceWorld = multiply(rotation.map(row => row.map((v, axis) => v * record[axis + 4]! ** 2)), transpose(rotation));
  const camera = [0, 1, 2].map(row => [frame.viewMatrix[row]!, frame.viewMatrix[row + 4]!, frame.viewMatrix[row + 8]!]);
  const covarianceView = multiply(multiply(camera, covarianceWorld), transpose(camera));
  const [fx, fy] = frame.focalPixels, invZ = 1 / position[2]!;
  const jacobian = [[fx * invZ, 0, -fx * position[0]! * invZ * invZ], [0, fy * invZ, -fy * position[1]! * invZ * invZ]];
  const projected = multiply(multiply(jacobian, covarianceView), transpose(jacobian));
  return { centerPixels: [(clip[0]! / clip[3]! * .5 + .5) * frame.viewportPixels[0],
    (.5 - clip[1]! / clip[3]! * .5) * frame.viewportPixels[1]], depth: clip[2]! / clip[3]!,
    covariance: [projected[0]![0]! + SPLAT_COVARIANCE_PAD_PX2, projected[0]![1]!, projected[1]![1]! + SPLAT_COVARIANCE_PAD_PX2],
    alpha: record[15]! };
}
export function projectedSplatAlpha(sample: ProjectedSplat, pixelX: number, pixelY: number): number {
  const [xx, xy, yy] = sample.covariance, dx = pixelX - sample.centerPixels[0], dy = -(pixelY - sample.centerPixels[1]);
  const determinant = xx * yy - xy * xy;
  const alpha = sample.alpha * Math.exp(-.5 * (yy * dx * dx - 2 * xy * dx * dy + xx * dy * dy) / determinant);
  return alpha < SPLAT_ALPHA_CUTOFF ? 0 : alpha;
}
