import { applyMat4, invertMat4, pixelRayProbe, type InstanceRows, type Mat4, type Vec4 } from "./temporalMotionReference.js";

/**
 * Deterministic synthetic sequences for the T07 GPU integration harness:
 * thin fence, thin tube, rotating blades, moving character. Pure f64 analytic
 * ray casting on Node — the GPU side receives color/depth/world textures plus the
 * per-frame matrices, mirroring what the production vertex stage feeds its MV path.
 *
 * Acceptance framing (mirrors the CPU slice): frames [0, moveFrames) animate,
 * frame `moveFrames` is the content change (pattern flip / stop), frames
 * [moveFrames, end) are static; ghost energy is measured on the three post-change
 * frames against the current-frame ideal.
 */

export type Vec3 = readonly [number, number, number];

export interface SequenceFrame {
  readonly color: Float32Array;
  readonly depth: Float32Array;
  readonly world: Float32Array;
  readonly viewProjection: Mat4;
  readonly previousViewProjection: Mat4;
  /** rel = previousModel * inverse(model), 3 rows per objectId (bg id 0 unused). */
  readonly relativeRows: readonly InstanceRows[];
}

export interface TemporalSequence {
  readonly name: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly sourceContrast: number;
  readonly moveFrames: number;
  readonly frames: readonly SequenceFrame[];
  readonly palette: readonly Vec3[];
}

function multiplyMat4(a: Mat4, b: Mat4): Float64Array<ArrayBuffer> {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    out[column * 4 + row] = a[row]! * b[column * 4]! + a[4 + row]! * b[column * 4 + 1]!
      + a[8 + row]! * b[column * 4 + 2]! + a[12 + row]! * b[column * 4 + 3]!;
  }
  return out;
}

/** Right-handed look-at view matrix (camera looks down -Z, positive view depth = -z). */
export function lookAtView(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Float64Array<ArrayBuffer> {
  const normalize = (v: readonly number[]): Vec3 => {
    const length = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (!(length > 1e-9)) throw new Error("Sequence camera basis is degenerate.");
    return [v[0]! / length, v[1]! / length, v[2]! / length];
  };
  const forward = normalize([target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]);
  const right = normalize([forward[1]! * up[2]! - forward[2]! * up[1]!, forward[2]! * up[0]! - forward[0]! * up[2]!, forward[0]! * up[1]! - forward[1]! * up[0]!]);
  const cameraUp = [right[1]! * forward[2]! - right[2]! * forward[1]!, right[2]! * forward[0]! - right[0]! * forward[2]!, right[0]! * forward[1]! - right[1]! * forward[0]!] as Vec3;
  return new Float64Array([right[0]!, cameraUp[0]!, -forward[0]!, 0, right[1]!, cameraUp[1]!, -forward[1]!, 0,
    right[2]!, cameraUp[2]!, -forward[2]!, 0,
    -(right[0]! * eye[0]! + right[1]! * eye[1]! + right[2]! * eye[2]!),
    -(cameraUp[0]! * eye[0]! + cameraUp[1]! * eye[1]! + cameraUp[2]! * eye[2]!),
    forward[0]! * eye[0]! + forward[1]! * eye[1]! + forward[2]! * eye[2]!, 1]);
}

/** Column-major perspective; depth = linear view depth is kept separately (TAA convention). */
export function perspective(verticalFovRadians: number, aspect: number, near: number, far: number): Float64Array<ArrayBuffer> {
  if (!(verticalFovRadians > 0 && verticalFovRadians < Math.PI) || !(near > 0) || !(far > near) || !(aspect > 0)) throw new Error("Sequence projection is invalid.");
  const f = 1 / Math.tan(verticalFovRadians / 2), range = 1 / (near - far);
  return new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * range, -1, 0, 0, 2 * far * near * range, 0]);
}

interface Surface {
  readonly color: Vec3;
  /** Model (column-major) placing the unit shape into the world. */
  readonly model: Mat4;
  readonly kind: "box" | "cylinder";
}

const IDENTITY = (): Float64Array<ArrayBuffer> => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const translation = (x: number, y: number, z: number): Float64Array<ArrayBuffer> => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scaling = (x: number, y: number, z: number): Float64Array<ArrayBuffer> => new Float64Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
const rotationZ = (radians: number): Float64Array<ArrayBuffer> => {
  const c = Math.cos(radians), s = Math.sin(radians);
  return new Float64Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
};
const compose = (...matrices: readonly Mat4[]): Mat4 => matrices.reduce((left, right) => multiplyMat4(left, right));

/** Ray (world origin + unit direction) into shape-local space; both ends transformed consistently. */
const rayLocal = (inverse: Mat4, worldOrigin: Vec3, direction: Vec3): [Vec4, Vec3] => {
  const localOrigin = applyMat4(inverse, worldOrigin);
  const target = applyMat4(inverse, [worldOrigin[0]! + direction[0]!, worldOrigin[1]! + direction[1]!, worldOrigin[2]! + direction[2]!, 1]);
  return [localOrigin, [target[0]! - localOrigin[0]!, target[1]! - localOrigin[1]!, target[2]! - localOrigin[2]!]];
};

/** Slab test on the unit box [-0.5, 0.5]^3 in local space; returns [tNear, tFar] or undefined. */
function intersectBox(origin: Vec4, direction: Vec3): readonly [number, number] | undefined {
  let tNear = -Infinity, tFar = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis]!, d = direction[axis]!;
    if (Math.abs(d) < 1e-12) { if (o < -0.5 || o > 0.5) return undefined; continue; }
    let t0 = (-0.5 - o) / d, t1 = (0.5 - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tNear = Math.max(tNear, t0); tFar = Math.min(tFar, t1);
    if (tNear > tFar) return undefined;
  }
  return tFar < 1e-9 ? undefined : [Math.max(tNear, 1e-9), tFar];
}

/** Unit cylinder (axis local Y, radius 0.5, height 1) side+cap intersection. */
function intersectCylinder(origin: Vec4, direction: Vec3): readonly [number, number] | undefined {
  const ox = origin[0]!, oz = origin[2]!, dx = direction[0]!, dz = direction[2]!;
  const a = dx * dx + dz * dz, hits: number[] = [];
  if (a > 1e-12) {
    const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - 0.25;
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        const y = origin[1]! + t * direction[1]!;
        if (t > 1e-9 && y >= -0.5 && y <= 0.5) hits.push(t);
      }
    }
  }
  if (Math.abs(direction[1]!) > 1e-12) {
    for (const cap of [-0.5, 0.5]) {
      const t = (cap - origin[1]!) / direction[1]!;
      const x = ox + t * dx, z = oz + t * dz;
      if (t > 1e-9 && x * x + z * z <= 0.25) hits.push(t);
    }
  }
  if (hits.length === 0) return undefined;
  hits.sort((left, right) => left - right);
  return [hits[0]!, hits[hits.length - 1]!];
}

const LUMA = (color: Vec3): number => color[0]! * 0.25 + color[1]! * 0.5 + color[2]! * 0.25;

interface SequenceInput {
  readonly name: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly moveFrames: number;
  readonly staticFrames: number;
  readonly backgroundDepth: number;
  readonly verticalFovRadians: number;
  readonly palette: readonly Vec3[];
  /** Camera eye per frame index (target is always the origin). */
  readonly eyeAt: (frame: number, total: number) => Vec3;
  /** Surfaces per frame index; id is the palette+objectId slot (1-based). */
  readonly surfacesAt: (frame: number, total: number) => readonly Surface[];
}

function buildSequence(input: SequenceInput): TemporalSequence {
  const total = input.moveFrames + input.staticFrames;
  const frames: SequenceFrame[] = [];
  const aspect = input.width / input.height;
  for (let frame = 0; frame < total; frame++) {
    const eye = input.eyeAt(frame, total);
    const surfaces = input.surfacesAt(frame, total);
    const view = lookAtView(eye, [0, 0, 0]);
    const projection = perspective(input.verticalFovRadians, aspect, 0.1, 100);
    const viewProjection = compose(projection, view);
    const previousEye = input.eyeAt(Math.max(0, frame - 1), total);
    const previousSurfaces = input.surfacesAt(Math.max(0, frame - 1), total);
    const previousViewProjection = compose(projection, lookAtView(previousEye, [0, 0, 0]));
    const inverseViewProjection = invertMat4(viewProjection);
    const inverseModels = surfaces.map(surface => invertMat4(surface.model));
    const relativeRows: InstanceRows[] = surfaces.map((surface, index) => {
      const relative = multiplyMat4(previousSurfaces[index]!.model, inverseModels[index]!);
      return [[relative[0]!, relative[1]!, relative[2]!, relative[3]!],
        [relative[4]!, relative[5]!, relative[6]!, relative[7]!],
        [relative[8]!, relative[9]!, relative[10]!, relative[11]!]] as InstanceRows;
    });
    const pixels = input.width * input.height;
    const color = new Float32Array(pixels * 4), depth = new Float32Array(pixels), world = new Float32Array(pixels * 4);
    const background: Surface = { color: input.palette[0]!, model: IDENTITY(), kind: "box" };
    for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
      const probe = pixelRayProbe(inverseViewProjection, eye, x + 0.5, y + 0.5, input.width, input.height, 1);
      const direction: Vec3 = [probe[0]! - eye[0]!, probe[1]! - eye[1]!, probe[2]! - eye[2]!];
      const length = Math.hypot(...direction);
      const unit = [direction[0]! / length, direction[1]! / length, direction[2]! / length] as Vec3;
      let bestT = input.backgroundDepth, bestIndex = -1;
      for (let index = 0; index < surfaces.length; index++) {
        const inverse = inverseModels[index]!;
        const [localOrigin, localDirection] = rayLocal(inverse, eye, unit);
        const hit = surfaces[index]!.kind === "box" ? intersectBox(localOrigin, localDirection) : intersectCylinder(localOrigin, localDirection);
        if (hit && hit[0]! < bestT) { bestT = hit[0]!; bestIndex = index; }
      }
      const viewForward: Vec3 = [-(view[8]!), -(view[9]!), -(view[10]!)];
      const viewDepth = bestT * (unit[0]! * viewForward[0]! + unit[1]! * viewForward[1]! + unit[2]! * viewForward[2]!);
      const hitPoint: Vec3 = [eye[0]! + unit[0]! * bestT, eye[1]! + unit[1]! * bestT, eye[2]! + unit[2]! * bestT];
      const surface = bestIndex >= 0 ? surfaces[bestIndex]! : background;
      const pixel = y * input.width + x;
      color.set([surface.color[0], surface.color[1], surface.color[2], 1], pixel * 4);
      depth[pixel] = viewDepth;
      world.set([hitPoint[0], hitPoint[1], hitPoint[2], bestIndex + 1], pixel * 4);
    }
    frames.push({ color, depth, world, viewProjection, previousViewProjection, relativeRows });
  }
  const contrast = Math.max(...input.palette.slice(1).map(color => LUMA(color))) - LUMA(input.palette[0]!);
  return Object.freeze({ name: input.name, description: input.description, width: input.width, height: input.height,
    sourceContrast: contrast, moveFrames: input.moveFrames, frames: Object.freeze(frames), palette: Object.freeze(input.palette) });
}

const FOV = Math.PI / 3;

/** 细栅栏:相机横移使栅栏扫过画面,切帧栅栏半相位翻转(奈奎斯特违例场景的实拍版)。 */
export function buildFenceSequence(width = 96, height = 96): TemporalSequence {
  const pitch = 8, bars = 14, panelZ = -6;
  return buildSequence({
    name: "fence", width, height, moveFrames: 5, staticFrames: 3, backgroundDepth: 12, verticalFovRadians: FOV,
    description: "细栅栏:相机横移 5 帧后停止,切帧栅栏半相位翻转后静止(薄结构 + 内容切换)",
    palette: [[0.03, 0.03, 0.035], [0.85, 0.4, 0.15]],
    eyeAt: (frame) => [frame < 5 ? (frame - 2) * 0.15 : 0.3, 0, 2],
    surfacesAt: (frame) => {
      const flip = frame >= 5 ? pitch / 2 : 0;
      return Array.from({ length: bars }, (_, bar) => ({
        color: [0.85, 0.4, 0.15] as Vec3,
        model: compose(translation((bar - bars / 2) * pitch / bars * 2 + flip * pitch / bars * 2, 0, panelZ), scaling(0.125, 3, 0.125)),
        kind: "box" as const }));
    },
  });
}

/** 薄管:斜置细圆柱平移,切帧停止(对角薄结构双线性历史跨背景)。 */
export function buildThinTubeSequence(width = 96, height = 96): TemporalSequence {
  return buildSequence({
    name: "thin-tube", width, height, moveFrames: 5, staticFrames: 3, backgroundDepth: 12, verticalFovRadians: FOV,
    description: "薄管:斜置细圆柱对角平移 5 帧后静止(对角薄结构)",
    palette: [[0.03, 0.03, 0.035], [0.2, 0.75, 0.9]],
    eyeAt: () => [0, 0, 2],
    surfacesAt: (frame) => {
      const shift = frame < 5 ? (frame - 2) * 0.14 : 0.28;
      return [{ color: [0.2, 0.75, 0.9], model: compose(translation(shift, shift * 0.5, -5), rotationZ(0.5), scaling(0.16, 6, 0.16)), kind: "cylinder" }];
    },
  });
}

/** 旋转叶片:三叶风扇绕轴旋转,切帧停止(旋转 MV + 后缘失遮挡)。 */
export function buildRotatingBladesSequence(width = 96, height = 96): TemporalSequence {
  const STEP = 12 * Math.PI / 180;
  const blade = (angle: number): Surface => ({ color: [0.9, 0.85, 0.2], model: compose(rotationZ(angle), translation(0, 1.4, -5), scaling(0.3, 2, 0.05)), kind: "box" });
  const hub: Surface = { color: [0.5, 0.5, 0.55], model: compose(translation(0, 0, -5), scaling(0.45, 0.45, 0.2)), kind: "cylinder" };
  return buildSequence({
    name: "rotating-blades", width, height, moveFrames: 5, staticFrames: 3, backgroundDepth: 12, verticalFovRadians: FOV,
    description: "旋转叶片:三叶风扇每帧 12° 旋转 5 帧后静止(旋转运动 + 叶尖失遮挡)",
    palette: [[0.03, 0.03, 0.035], [0.9, 0.85, 0.2], [0.5, 0.5, 0.55]],
    eyeAt: () => [0, 0, 2],
    surfacesAt: (frame) => {
      const angle = (frame < 5 ? frame : 4) * STEP;
      return [blade(angle), blade(angle + 2 * Math.PI / 3), blade(angle + 4 * Math.PI / 3), hub];
    },
  });
}

/** 移动角色:六部件人形四肢摆动行走,切帧停止(多对象实例级 MV)。 */
export function buildMovingCharacterSequence(width = 96, height = 96): TemporalSequence {
  const torso: Vec3 = [0.85, 0.2, 0.3], limbs: Vec3 = [0.2, 0.45, 0.85], head: Vec3 = [0.9, 0.6, 0.15];
  const part = (color: Vec3, swing: number, pivotY: number, offsetX: number, size: [number, number, number]): Surface =>
    ({ color, model: compose(translation(offsetX, pivotY, -5), rotationZ(swing), translation(0, -size[1]! / 2, 0), scaling(size[0]!, size[1]!, size[2]!)), kind: "box" });
  return buildSequence({
    name: "moving-character", width, height, moveFrames: 5, staticFrames: 3, backgroundDepth: 12, verticalFovRadians: FOV,
    description: "移动角色:六部件人形(头/躯干/双臂/双腿)行走 5 帧后静止(实例级刚体 MV)",
    palette: [[0.03, 0.03, 0.035], torso, head, limbs],
    eyeAt: (frame) => [frame < 5 ? (frame - 2) * 0.12 : 0.24, 0, 2],
    surfacesAt: (frame) => {
      const walk = frame < 5 ? (frame - 2) * 0.12 : 0.24;
      const swing = frame < 5 ? Math.sin(frame * 1.1) * 0.5 : Math.sin(4 * 1.1) * 0.5;
      return [
        { color: torso, model: compose(translation(walk, 0.1, -5), scaling(0.5, 0.8, 0.25)), kind: "box" },
        { color: head, model: compose(translation(walk, 0.75, -5), scaling(0.3, 0.3, 0.3)), kind: "box" },
        part(limbs, swing, 0.45, walk - 0.32, [0.14, 0.7, 0.14]), part(limbs, -swing, 0.45, walk + 0.32, [0.14, 0.7, 0.14]),
        part(limbs, -swing, -0.28, walk - 0.16, [0.16, 0.8, 0.16]), part(limbs, swing, -0.28, walk + 0.16, [0.16, 0.8, 0.16]),
      ];
    },
  });
}

export const buildAllSequences = (width = 96, height = 96): readonly TemporalSequence[] =>
  [buildFenceSequence(width, height), buildThinTubeSequence(width, height),
    buildRotatingBladesSequence(width, height), buildMovingCharacterSequence(width, height)];
