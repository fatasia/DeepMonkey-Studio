import type { SplatFrameUniforms } from "../gaussianSplat/splatGpuResources.js";
/** Existing mesh frame matrices may be camera-relative; splat records remain in world space. */
export function pbrSplatFrame(viewMatrix: ArrayLike<number>, viewProjectionMatrix: ArrayLike<number>,
  eye: readonly [number, number, number], width: number, height: number, verticalFov: number, near: number,
  origin?: readonly [number, number, number]): Omit<SplatFrameUniforms, "splatCount"> {
  const absolute = (matrix: ArrayLike<number>) => {
    if (!origin) return matrix;
    const result = new Float32Array(Array.from(matrix));
    for (let row = 0; row < 4; row++) result[12 + row] = matrix[12 + row]!
      - matrix[row]! * origin[0] - matrix[4 + row]! * origin[1] - matrix[8 + row]! * origin[2];
    return result;
  };
  const focal = height / (2 * Math.tan(verticalFov / 2));
  return { viewMatrix: absolute(viewMatrix), viewProjectionMatrix: absolute(viewProjectionMatrix),
    cameraPosition: eye, viewportPixels: [width, height], focalPixels: [focal, focal], near };
}
