import * as THREE from "three";
import { overlayLine, OVERLAY_VERTEX_LIMIT, type OverlayClipPoint, type OverlayColor } from "./studioDeepOverlayGeometry";

/**
 * Deep 原生编辑辅助图形原语(切片 A/B/C):从纯几何输入生成与
 * studioDeepEditorOverlay 相同顶点格式的 Float32Array(clip xyzw + sRGB RGBA,8 floats/vertex)。
 * 只读输入,不改任何 Three 状态;线宽合同与既有 overlay 一致(1 CSS px × pixelRatio)。
 */

/** 合同对齐 viewerEngineRendering 的 Box3Helper 选择高亮材质。 */
export const DEEP_SELECTION_BOX_COLOR = 0x2684ff;
export const DEEP_SELECTION_BOX_OPACITY = 0.95;
/** 合同对齐 sceneOverlayVisuals.createMeasurementVisual 的线材颜色与透明度。 */
export const DEEP_MEASUREMENT_PREVIEW_COLOR = 0xf0d58d;
export const DEEP_MEASUREMENT_PREVIEW_OPACITY = 0.75;
export const DEEP_MEASUREMENT_COLOR = 0xf6c453;
/** 刻度尺寸沿用 createMeasurementVisual 端点 marker 的量级公式。 */
const MEASUREMENT_TICK_SIZE_FACTOR = 0.012;
const MEASUREMENT_TICK_MIN_SIZE = 0.035;
/** 合同对齐 three TransformControls 轴色(X/Y/Z 红/绿/蓝)。 */
export const DEEP_GIZMO_AXIS_COLORS = [0xff0000, 0x00ff00, 0x0000ff] as const;
const GIZMO_RING_SEGMENTS = 48;
/** gizmo 世界尺寸随相机距离缩放,保持屏幕占比近似恒定(TransformControls 同策略)。 */
const GIZMO_SIZE_DISTANCE_FACTOR = 0.18;
const GIZMO_HEAD_LENGTH_FACTOR = 0.28;
const GIZMO_HEAD_RADIUS_FACTOR = 0.09;

export type DeepTransformGizmoMode = "translate" | "rotate" | "scale";
export interface DeepTransformGizmoInput {
  /** 选中对象的世界矩阵(只读);原语位置/朝向跟随它,尺寸跟随相机距离。 */
  readonly matrix: THREE.Matrix4;
  readonly mode: DeepTransformGizmoMode;
}
export interface DeepMeasurementSegmentInput {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly preview: boolean;
}

/** 把 Deep 原语顶点并入既有 overlay 投影结果;预算与 projectStudioEditorOverlay 一致,fail-closed。 */
export function mergeDeepOverlayVertices(base: Float32Array, primitives: readonly Float32Array[]): Float32Array<ArrayBuffer> {
  let total = base.length;
  for (const primitive of primitives) {
    if (primitive.length % 8 !== 0) throw new Error("Deep overlay primitive has a partial vertex.");
    total += primitive.length;
  }
  if (!Number.isSafeInteger(total) || total > OVERLAY_VERTEX_LIMIT) throw new Error("Editor overlay geometry exceeds its vertex budget.");
  if (!primitives.length) return base as Float32Array<ArrayBuffer>;
  const merged = new Float32Array(total);
  merged.set(base, 0);
  let offset = base.length;
  for (const primitive of primitives) {
    merged.set(primitive, offset);
    offset += primitive.length;
  }
  return merged;
}

/** 切片 A:世界包围盒 → 12 边线框盒;空盒输出空数组,角点非有限 fail-closed。 */
export function projectDeepSelectionBox(box: THREE.Box3, camera: THREE.Camera,
  width: number, height: number, pixelRatio: number): Float32Array<ArrayBuffer> {
  assertViewport(width, height, pixelRatio);
  if (box.isEmpty()) return new Float32Array();
  const color = overlayDisplayColor(DEEP_SELECTION_BOX_COLOR, DEEP_SELECTION_BOX_OPACITY);
  const viewProjection = viewProjectionMatrix(camera);
  const corners: THREE.Vector3[] = [];
  for (const [x, y, z] of [
    [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
    [box.max.x, box.max.y, box.min.z], [box.min.x, box.max.y, box.min.z],
    [box.min.x, box.min.y, box.max.z], [box.max.x, box.min.y, box.max.z],
    [box.max.x, box.max.y, box.max.z], [box.min.x, box.max.y, box.max.z],
  ] as const) corners.push(finitePoint(x, y, z, "deep overlay selection box"));
  // 底面 4 边 + 顶面 4 边 + 立柱 4 边。
  const edges: readonly [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const output: number[] = [];
  for (const [a, b] of edges) appendWorldLine(output, corners[a]!, corners[b]!, viewProjection, color, width * pixelRatio, height * pixelRatio, pixelRatio);
  return new Float32Array(output);
}

/** 切片 B:两点测量线段 + 两端十字刻度(billboard 正交基);零长线段输出空数组。 */
export function projectDeepMeasurementSegment(input: DeepMeasurementSegmentInput, camera: THREE.Camera,
  width: number, height: number, pixelRatio: number): Float32Array<ArrayBuffer> {
  assertViewport(width, height, pixelRatio);
  const length = input.a.distanceTo(input.b);
  if (!Number.isFinite(length)) throw new Error("Deep overlay measurement points must be finite.");
  if (length <= 0) return new Float32Array();
  const color = overlayDisplayColor(input.preview ? DEEP_MEASUREMENT_PREVIEW_COLOR : DEEP_MEASUREMENT_COLOR,
    input.preview ? DEEP_MEASUREMENT_PREVIEW_OPACITY : 1);
  const viewProjection = viewProjectionMatrix(camera);
  const output: number[] = [];
  const physicalWidth = width * pixelRatio, physicalHeight = height * pixelRatio;
  appendWorldLine(output, input.a, input.b, viewProjection, color, physicalWidth, physicalHeight, pixelRatio);
  const direction = finitePoint(input.b.x - input.a.x, input.b.y - input.a.y, input.b.z - input.a.z, "deep overlay measurement")
    .normalize();
  const tick = Math.max(length * MEASUREMENT_TICK_SIZE_FACTOR, MEASUREMENT_TICK_MIN_SIZE);
  const sight = camera.position.clone().sub(input.a).normalize();
  const first = new THREE.Vector3().crossVectors(direction, sight);
  if (first.lengthSq() < 1e-12) first.set(0, 0, 1).cross(direction);
  if (first.lengthSq() < 1e-12) first.set(1, 0, 0);
  first.normalize();
  const second = new THREE.Vector3().crossVectors(direction, first).normalize();
  for (const endpoint of [input.a, input.b]) {
    appendWorldLine(output, endpoint.clone().addScaledVector(first, -tick), endpoint.clone().addScaledVector(first, tick),
      viewProjection, color, physicalWidth, physicalHeight, pixelRatio);
    appendWorldLine(output, endpoint.clone().addScaledVector(second, -tick), endpoint.clone().addScaledVector(second, tick),
      viewProjection, color, physicalWidth, physicalHeight, pixelRatio);
  }
  return new Float32Array(output);
}

/** 切片 C:gizmo 呈现层原语——translate/scale 为轴向箭头,rotate 为轴向旋转环;交互仍由 TransformControls 持有。 */
export function projectDeepTransformGizmo(input: DeepTransformGizmoInput, camera: THREE.Camera,
  width: number, height: number, pixelRatio: number): Float32Array<ArrayBuffer> {
  assertViewport(width, height, pixelRatio);
  const origin = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  input.matrix.decompose(origin, quaternion, scale);
  if (![origin.x, origin.y, origin.z, scale.x, scale.y, scale.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w]
    .every(Number.isFinite)) throw new Error("Deep overlay transform gizmo matrix must be finite.");
  const size = camera.position.distanceTo(origin) * GIZMO_SIZE_DISTANCE_FACTOR;
  const viewProjection = viewProjectionMatrix(camera);
  const physicalWidth = width * pixelRatio, physicalHeight = height * pixelRatio;
  const output: number[] = [];
  const sight = camera.position.clone().sub(origin).normalize();
  for (let axis = 0; axis < 3; axis++) {
    // 退化轴(零缩放矩阵等)fail-closed:整轴不产生顶点,而非泄漏零长度刻度线。
    const raw = new THREE.Vector3().setFromMatrixColumn(input.matrix, axis);
    if (raw.lengthSq() < 1e-12) continue;
    raw.normalize();
    const direction = finitePoint(raw.x, raw.y, raw.z, "deep overlay transform gizmo matrix");
    const color = overlayDisplayColor(DEEP_GIZMO_AXIS_COLORS[axis]!, 1);
    if (input.mode === "rotate") {
      appendRing(output, origin, direction, size, viewProjection, color, physicalWidth, physicalHeight, pixelRatio);
      continue;
    }
    appendArrow(output, origin, direction, size, sight, viewProjection, color, physicalWidth, physicalHeight, pixelRatio);
  }
  return new Float32Array(output);
}

function appendArrow(output: number[], origin: THREE.Vector3, axis: THREE.Vector3, size: number, sight: THREE.Vector3,
  viewProjection: THREE.Matrix4, color: OverlayColor, width: number, height: number, lineWidth: number): void {
  appendWorldLine(output, origin, origin.clone().addScaledVector(axis, size), viewProjection, color, width, height, lineWidth);
  // 箭头头部:含轴与视线方向的平面内的三角形线框,任何视角都呈现清晰箭形。
  const headLength = size * GIZMO_HEAD_LENGTH_FACTOR;
  const headRadius = size * GIZMO_HEAD_RADIUS_FACTOR;
  const side = orthogonalUnit(axis, sight);
  const tip = origin.clone().addScaledVector(axis, size + headLength);
  const base = origin.clone().addScaledVector(axis, size);
  const cornerA = base.clone().addScaledVector(side, headRadius);
  const cornerB = base.clone().addScaledVector(new THREE.Vector3().crossVectors(axis, side).normalize(), headRadius);
  for (const [a, b] of [[tip, cornerA], [tip, cornerB], [cornerA, cornerB]] as const) {
    appendWorldLine(output, a, b, viewProjection, color, width, height, lineWidth);
  }
}

function appendRing(output: number[], origin: THREE.Vector3, normal: THREE.Vector3, radius: number,
  viewProjection: THREE.Matrix4, color: OverlayColor, width: number, height: number, lineWidth: number): void {
  // 环绕法向旋转对称,基向量取固定参考即可;参考与法向平行时由 orthogonalUnit 回退。
  const first = orthogonalUnit(normal, new THREE.Vector3(0, 0, 1));
  const second = new THREE.Vector3().crossVectors(normal, first).normalize();
  let previous = origin.clone().addScaledVector(first, radius);
  for (let segment = 1; segment <= GIZMO_RING_SEGMENTS; segment++) {
    const angle = Math.PI * 2 * segment / GIZMO_RING_SEGMENTS;
    const current = origin.clone()
      .addScaledVector(first, Math.cos(angle) * radius)
      .addScaledVector(second, Math.sin(angle) * radius);
    appendWorldLine(output, previous, current, viewProjection, color, width, height, lineWidth);
    previous = current;
  }
}

function viewProjectionMatrix(camera: THREE.Camera): THREE.Matrix4 {
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

/** 复刻既有 overlay 管线对材质颜色的处理:sRGB hex → linear → 显示 sRGB,保证呈现合同一致。 */
function overlayDisplayColor(hex: number, alpha: number): OverlayColor {
  const display = new THREE.Color(hex).convertLinearToSRGB();
  return [display.r, display.g, display.b, alpha];
}

function appendWorldLine(output: number[], a: THREE.Vector3, b: THREE.Vector3, viewProjection: THREE.Matrix4,
  color: OverlayColor, width: number, height: number, lineWidth: number): void {
  const clipA = new THREE.Vector4(a.x, a.y, a.z, 1).applyMatrix4(viewProjection);
  const clipB = new THREE.Vector4(b.x, b.y, b.z, 1).applyMatrix4(viewProjection);
  const point = (clip: THREE.Vector4): OverlayClipPoint => {
    if (![clip.x, clip.y, clip.z, clip.w].every(Number.isFinite)) throw new Error("Deep overlay positions must be finite.");
    return [clip.x, clip.y, clip.z, clip.w];
  };
  overlayLine(output, point(clipA), point(clipB), color, width, height, lineWidth);
}

function finitePoint(x: number, y: number, z: number, subject: string): THREE.Vector3 {
  if (![x, y, z].every(Number.isFinite)) throw new Error(`${subject} must be finite.`);
  return new THREE.Vector3(x, y, z);
}

/** 与 axis 正交且尽量贴近参考方向的单位向量;参考方向退化时回退到固定正交基。 */
function orthogonalUnit(axis: THREE.Vector3, reference: THREE.Vector3): THREE.Vector3 {
  const side = new THREE.Vector3().crossVectors(axis, reference);
  if (side.lengthSq() < 1e-12) side.set(0, 0, 1).cross(axis);
  if (side.lengthSq() < 1e-12) side.set(1, 0, 0);
  return side.normalize();
}

function assertViewport(width: number, height: number, pixelRatio: number): void {
  if (![width, height, pixelRatio].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid deep overlay viewport.");
}
