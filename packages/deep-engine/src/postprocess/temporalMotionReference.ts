import { currentToPreviousUvMotion } from "../webgpu/pbrMotionCpu.js";

/**
 * Analytic motion-vector reference for the Deep temporal pipeline.
 *
 * Mirrors the shipped GPU formulas without modifying them:
 * - Vertex: currentClip = VP_current * world, previousClip = VP_previous * previousWorld
 *   (pbrShader.ts vertexMain / vertexNormalMapped, pbrDeformationShader.ts deepPoseVertex).
 * - Fragment: motion = clipUv(previousClip) - clipUv(currentClip) - projectionJitterDeltaUv,
 *   clamped to [-2, 2] UV (pbrShader.ts geometryOutput).
 * - TAA consumption: previousPixel = pixel + 0.5 + motion * size + (previousJitter - currentJitter)
 *   (temporalAaCpu.ts resolveTemporalAaCpu, temporalAaWgsl.ts resolveTemporal).
 */
export type Mat4 = Float32Array | Float64Array | readonly number[];
export type Vec4 = readonly [number, number, number, number];
export type InstanceRows = readonly [Vec4, Vec4, Vec4];

const IDENTITY_ROWS: InstanceRows = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

export function applyMat4(matrix: Mat4, xyz: readonly number[]): Vec4 {
  if (matrix.length !== 16 || ![...matrix, ...xyz].every(Number.isFinite)) throw new Error("Motion reference matrix or point is invalid.");
  const [x, y, z] = xyz;
  return [matrix[0]! * x! + matrix[4]! * y! + matrix[8]! * z! + matrix[12]!,
    matrix[1]! * x! + matrix[5]! * y! + matrix[9]! * z! + matrix[13]!,
    matrix[2]! * x! + matrix[6]! * y! + matrix[10]! * z! + matrix[14]!,
    matrix[3]! * x! + matrix[7]! * y! + matrix[11]! * z! + matrix[15]!];
}

/** Instance model rows applied as world = vec3(dot(row0,p), dot(row1,p), dot(row2,p)). */
export function applyInstanceRows(rows: InstanceRows, modelPoint: readonly number[]): [number, number, number] {
  return [rows[0][0]! * modelPoint[0]! + rows[0][1]! * modelPoint[1]! + rows[0][2]! * modelPoint[2]! + rows[0][3]!,
    rows[1][0]! * modelPoint[0]! + rows[1][1]! * modelPoint[1]! + rows[1][2]! * modelPoint[2]! + rows[1][3]!,
    rows[2][0]! * modelPoint[0]! + rows[2][1]! * modelPoint[1]! + rows[2][2]! * modelPoint[2]! + rows[2][3]!];
}

export interface MotionSampleInput {
  readonly currentViewProjection: Mat4;
  readonly previousViewProjection: Mat4;
  /** (previousJitter - currentJitter) / (width, height), as packed by pbrFrameUniforms. */
  readonly jitterDeltaUv: readonly [number, number];
  /** Model-space vertex position shared by both frames (static geometry). */
  readonly modelPoint: readonly number[];
  readonly currentRows?: InstanceRows;
  readonly previousRows?: InstanceRows;
  /** Skeletal/deformation pose override (pbrDeformationShader deepCurrentPose/deepPreviousPose). */
  readonly currentPose?: readonly number[];
  readonly previousPose?: readonly number[];
}

/** Analytic motion for one sample; matches pbrMotionCpu.currentToPreviousUvMotion semantics. */
export function analyticMotion(input: MotionSampleInput): readonly [number, number] {
  const clampUv = (value: number) => Math.max(-2, Math.min(2, value));
  const currentWorld = applyInstanceRows(input.currentRows ?? IDENTITY_ROWS, input.currentPose ?? input.modelPoint);
  const previousWorld = applyInstanceRows(input.previousRows ?? IDENTITY_ROWS, input.previousPose ?? input.modelPoint);
  const currentClip = applyMat4(input.currentViewProjection, currentWorld);
  const previousClip = applyMat4(input.previousViewProjection, previousWorld);
  if (Math.abs(currentClip[3]!) < 1e-8 || Math.abs(previousClip[3]!) < 1e-8) throw new Error("Motion sample has a degenerate clip w.");
  const toUv = (clip: Vec4): readonly [number, number] => [clip[0]! / clip[3]! * 0.5 + 0.5, clip[1]! / clip[3]! * -0.5 + 0.5];
  const current = toUv(currentClip), previous = toUv(previousClip);
  return [clampUv(previous[0] - current[0] - input.jitterDeltaUv[0]), clampUv(previous[1] - current[1] - input.jitterDeltaUv[1])];
}

export interface MotionField {
  readonly width: number;
  readonly height: number;
  readonly motionUv: Float32Array;
}

/** General 4x4 (column-major) inverse; used by fixtures to lift pixel probes into world space. */
export function invertMat4(matrix: Mat4): Float32Array<ArrayBuffer> {
  const m = matrix as ArrayLike<number>, inverse = new Float32Array(16);
  const cofactor = (row: number, column: number) => {
    const rowsLeft = [0, 1, 2, 3].filter(index => index !== row);
    const columnsLeft = [0, 1, 2, 3].filter(index => index !== column);
    const minor = rowsLeft.map(i => columnsLeft.map(j => m[j * 4 + i]!));
    const r0 = minor[0]!, r1 = minor[1]!, r2 = minor[2]!;
    const determinant = (r0[0]! * (r1[1]! * r2[2]! - r1[2]! * r2[1]!)
      - r0[1]! * (r1[0]! * r2[2]! - r1[2]! * r2[0]!)
      + r0[2]! * (r1[0]! * r2[1]! - r1[1]! * r2[0]!));
    return ((row + column) % 2 === 0 ? 1 : -1) * determinant;
  };
  let determinant = 0;
  for (let column = 0; column < 4; column++) { inverse[column * 4] = cofactor(column, 0); determinant += m[column]! * inverse[column * 4]!; }  if (Math.abs(determinant) < 1e-12) throw new Error("Motion reference matrix is not invertible.");
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) inverse[column * 4 + row] = cofactor(column, row) / determinant;
  return inverse;
}

/**
 * Per-pixel motion field. `probeToWorld` maps a pixel center (px+0.5, py+0.5) to the
 * sample input at that pixel; fixtures typically back-project via invertMat4 at a fixed
 * view depth. This is the CPU stand-in for vertex-stage clip interpolation.
 */
export function analyticMotionField(width: number, height: number,
  probeToWorld: (px: number, py: number) => MotionSampleInput): MotionField {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error("Motion field dimensions are invalid.");
  const motionUv = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const motion = analyticMotion(probeToWorld(x + 0.5, y + 0.5));
    motionUv[(y * width + x) * 2] = motion[0];
    motionUv[(y * width + x) * 2 + 1] = motion[1];
  }
  return Object.freeze({ width, height, motionUv });
}

/** Reference field built by delegating every pixel's clips to the shipped pbrMotionCpu mirror. */
export function mirroredMotionField(width: number, height: number,
  probeToWorld: (px: number, py: number) => MotionSampleInput): MotionField {
  const motionUv = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const input = probeToWorld(x + 0.5, y + 0.5);
    const currentWorld = applyInstanceRows(input.currentRows ?? IDENTITY_ROWS, input.currentPose ?? input.modelPoint);
    const previousWorld = applyInstanceRows(input.previousRows ?? IDENTITY_ROWS, input.previousPose ?? input.modelPoint);
    const motion = currentToPreviousUvMotion(applyMat4(input.currentViewProjection, currentWorld),
      applyMat4(input.previousViewProjection, previousWorld), input.jitterDeltaUv);
    motionUv[(y * width + x) * 2] = motion[0];
    motionUv[(y * width + x) * 2 + 1] = motion[1];
  }
  return Object.freeze({ width, height, motionUv });
}

export interface MotionVerification {
  readonly label: string;
  readonly pixels: number;
  readonly matched: boolean;
  readonly maxUvError: number;
  readonly toleranceUv: number;
  readonly mismatchedPixels: number;
}

/** Per-pixel assertion between an analytic field and a mirrored/candidate field. */
export function verifyMotionField(expected: MotionField, actual: MotionField, toleranceUv: number, label: string): MotionVerification {
  if (expected.width !== actual.width || expected.height !== actual.height) throw new Error("Motion field dimensions differ.");
  if (!(toleranceUv >= 0) || !Number.isFinite(toleranceUv)) throw new Error("Motion tolerance is invalid.");
  let maxUvError = 0, mismatchedPixels = 0;
  for (let index = 0; index < expected.motionUv.length; index++) {
    const error = Math.hypot(expected.motionUv[index]! - actual.motionUv[index]!);
    maxUvError = Math.max(maxUvError, error);
    if (error > toleranceUv) mismatchedPixels++;
  }
  return Object.freeze({ label, pixels: expected.width * expected.height, matched: mismatchedPixels === 0,
    maxUvError, toleranceUv, mismatchedPixels });
}

/**
 * World point at camera distance `distance` along the ray through one pixel center.
 * The ndc z=0 plane unprojects to the near-plane ray anchor, so the ray direction is
 * (anchor - eye) and the probe is eye + direction * distance.
 */
export function pixelRayProbe(inverseViewProjection: Mat4, eye: readonly number[], px: number, py: number,
  width: number, height: number, distance: number): [number, number, number] {
  const ndcX = px / width * 2 - 1, ndcY = (1 - py / height) * 2 - 1;
  const anchor = applyMat4(inverseViewProjection, [ndcX, ndcY, 0, 1]);
  if (Math.abs(anchor[3]) < 1e-12) throw new Error("Pixel ray anchor unprojection is degenerate.");
  const direction = [anchor[0]! / anchor[3]! - eye[0]!, anchor[1]! / anchor[3]! - eye[1]!, anchor[2]! / anchor[3]! - eye[2]!];
  const length = Math.hypot(...direction);
  if (!(length > 1e-12) || !(distance > 0) || !Number.isFinite(distance)) throw new Error("Pixel ray probe distance is invalid.");
  return [eye[0]! + direction[0]! / length * distance, eye[1]! + direction[1]! / length * distance,
    eye[2]! + direction[2]! / length * distance];
}

/** TAA consumption closure: motion*size + jitterDeltaPixels must land on the analytic previous pixel. */
export function consumedPreviousPixel(field: MotionField, x: number, y: number,
  jitterDeltaPixels: readonly [number, number]): readonly [number, number] {
  const index = (y * field.width + x) * 2;
  return [x + 0.5 + field.motionUv[index]! * field.width + jitterDeltaPixels[0],
    y + 0.5 + field.motionUv[index + 1]! * field.height + jitterDeltaPixels[1]];
}
