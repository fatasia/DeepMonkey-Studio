import * as THREE from "three";
import { projectDeepMeasurementAngle, projectDeepMeasurementSegment, projectDeepSelectionBox, projectDeepTransformGizmo,
  type DeepMeasurementSegmentInput, type DeepTransformGizmoInput } from "./deepOverlayPrimitives";

/** Deep 模式下由桥注册进 StudioDeepRenderView 的原语顶点来源(每渲染帧调用一次)。 */
export type DeepOverlayPrimitiveSource =
  (width: number, height: number, pixelRatio: number) => readonly Float32Array[];

/** 引擎只读访问器集合(ViewerEngine 实现之);采集器不感知引擎内部状态。 */
export interface DeepOverlayPrimitiveViewer {
  readonly camera: THREE.PerspectiveCamera;
  getDeepSelectionBox(): THREE.Box3 | undefined;
  getDeepTransformGizmoInput(): DeepTransformGizmoInput | undefined;
  getDeepMeasurementSegmentInputs(): DeepMeasurementSegmentInput[];
}

/** 汇集切片 A/B/C 原语顶点;顺序:选择盒 → gizmo → 测量段。原语抛错沿渲染帧 failRuntime 回退 WebGL。 */
export function collectDeepOverlayPrimitives(viewer: DeepOverlayPrimitiveViewer,
  width: number, height: number, pixelRatio: number): readonly Float32Array[] {
  const primitives: Float32Array[] = [];
  const box = viewer.getDeepSelectionBox();
  if (box) primitives.push(projectDeepSelectionBox(box, viewer.camera, width, height, pixelRatio));
  const gizmo = viewer.getDeepTransformGizmoInput();
  if (gizmo) primitives.push(projectDeepTransformGizmo(gizmo, viewer.camera, width, height, pixelRatio));
  for (const segment of viewer.getDeepMeasurementSegmentInputs()) {
    primitives.push(segment.angle
      ? projectDeepMeasurementAngle({ points: segment.angle, preview: segment.preview }, viewer.camera, width, height, pixelRatio)
      : projectDeepMeasurementSegment(segment, viewer.camera, width, height, pixelRatio));
  }
  return primitives;
}
