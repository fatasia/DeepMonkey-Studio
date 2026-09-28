import type { RenderView } from "../webgpu/pbrRenderer.js";
import type { ThreeObjectSource } from "./types.js";

/** Pose sampling cadence only; author animation, root transforms and event clocks are never throttled. */
export type AuthorPoseLod = "precise" | "distant" | "outside";

const DISTANT_INTERVAL = 8;
const OUTSIDE_INTERVAL = 32;
const NEAR_PIXEL_DIAMETER = 24;
const NEAR_DISTANCE = 40;

export function shouldSampleAuthorPose(tier: AuthorPoseLod, lastSample: number | undefined, acceptedFrame: number): boolean {
  return tier === "precise" || lastSample === undefined || acceptedFrame - lastSample >=
    (tier === "distant" ? DISTANT_INTERVAL : OUTSIDE_INTERVAL);
}

/** Fail open to precise if a safe camera or static geometry bound cannot be established. */
export function authorPoseLod(object: ThreeObjectSource, view?: RenderView): AuthorPoseLod {
  const model = object as { userData?: { deepPoseCritical?: boolean; deepPoseBoundRadius?: number } };
  if (!view || model.userData?.deepPoseCritical === true) return "precise";
  const certifiedRadius = model.userData?.deepPoseBoundRadius;
  // The static geometry sphere cannot bound skinned vertices after arbitrary joint motion.
  // Only an author-certified animation envelope may enable pose decimation.
  if (certifiedRadius === undefined || !Number.isFinite(certifiedRadius) || certifiedRadius <= 0) return "precise";
  const matrix = object.matrixWorld?.elements;
  const eye = view.eye, target = view.target, up = view.up, fov = view.verticalFovRadians ?? Math.PI / 4;
  const near = view.near ?? 0.1, far = view.far ?? view.extent * 20;
  if (!matrix || matrix.length !== 16 || !eye || !target || !Number.isFinite(near) || near <= 0
    || !Number.isFinite(far) || far <= near || !Number.isFinite(fov)
    || fov <= 0 || fov >= Math.PI || !Number.isFinite(view.height)
    || !Number.isFinite(view.width) || view.width <= 0 || view.height <= 0) return "precise";
  for (const tuple of [eye, target, ...(up ? [up] : []), matrix]) for (let index = 0; index < tuple.length; index++) {
    if (!Number.isFinite(tuple[index])) return "precise";
  }
  const forward = normalize([target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]);
  const right = forward && normalize(cross(forward, up ?? [0, 1, 0]));
  const cameraUp = right && forward && cross(right, forward);
  if (!forward || !right || !cameraUp) return "precise";
  const position: [number, number, number] = [matrix[12]!, matrix[13]!, matrix[14]!];
  const delta: [number, number, number] = [position[0] - eye[0]!, position[1] - eye[1]!, position[2] - eye[2]!];
  const columnBound = Math.max(Math.abs(matrix[0]!) + Math.abs(matrix[1]!) + Math.abs(matrix[2]!),
    Math.abs(matrix[4]!) + Math.abs(matrix[5]!) + Math.abs(matrix[6]!),
    Math.abs(matrix[8]!) + Math.abs(matrix[9]!) + Math.abs(matrix[10]!));
  const rowBound = Math.max(Math.abs(matrix[0]!) + Math.abs(matrix[4]!) + Math.abs(matrix[8]!),
    Math.abs(matrix[1]!) + Math.abs(matrix[5]!) + Math.abs(matrix[9]!),
    Math.abs(matrix[2]!) + Math.abs(matrix[6]!) + Math.abs(matrix[10]!));
  // sqrt(||A||1 * ||A||inf) upper-bounds spectral scale even under shear.
  const radius = certifiedRadius * Math.sqrt(columnBound * rowBound);
  const depth = dot(delta, forward);
  if (!Number.isFinite(radius) || !Number.isFinite(depth)) return "precise";
  // Near field includes the radius: never defer a potentially close or prominently visible actor.
  if (depth - radius < NEAR_DISTANCE || depth <= radius) return "precise";
  const tanHalf = Math.tan(fov / 2);
  const pixelDiameter = radius * view.height / ((depth - radius) * tanHalf);
  if (pixelDiameter >= NEAR_PIXEL_DIAMETER) return "precise";
  const horizontalHalf = depth * tanHalf * view.width / view.height;
  const verticalHalf = depth * tanHalf;
  // A generous 2x bound protects the frustum margin and camera transitions.
  if (Math.abs(dot(delta, right)) > horizontalHalf + 2 * radius
    || Math.abs(dot(delta, cameraUp)) > verticalHalf + 2 * radius) return "outside";
  return "distant";
}

function dot(a: readonly number[], b: readonly number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
function normalize(value: [number, number, number]): [number, number, number] | undefined {
  const length = Math.hypot(...value);
  return Number.isFinite(length) && length > 1e-8 ? [value[0] / length, value[1] / length, value[2] / length] : undefined;
}
