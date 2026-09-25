import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { collectDeepOverlayPrimitives, type DeepOverlayPrimitiveViewer } from "./deepOverlayPrimitiveSource";

const camera = () => {
  const value = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  value.position.set(4, 3, 4);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
};

function viewer(overrides: Partial<DeepOverlayPrimitiveViewer> = {}): DeepOverlayPrimitiveViewer {
  return {
    camera: camera(),
    getDeepSelectionBox: () => new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    getDeepTransformGizmoInput: () => undefined,
    getDeepMeasurementSegmentInputs: () => [],
    ...overrides,
  };
}

describe("deep overlay primitive collector", () => {
  it("collects selection box, gizmo and measurement vertices in that order", () => {
    const primitives = collectDeepOverlayPrimitives(viewer({
      getDeepClippingBox: () => new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)),
      getDeepTransformGizmoInput: () => ({ matrix: new THREE.Matrix4(), mode: "translate" }),
      getDeepMeasurementSegmentInputs: () => [
        { a: new THREE.Vector3(0, 0, 0), b: new THREE.Vector3(1, 0, 0), preview: false },
        { a: new THREE.Vector3(), b: new THREE.Vector3(1, 0, 0), preview: false,
          angle: [new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)] },
      ],
    }), 128, 128, 1);
    expect(primitives).toHaveLength(5);
    expect(primitives[0]!.length).toBe(12 * 18 * 8); // 选择盒
    expect(primitives[1]!.length).toBe(12 * 18 * 8); // 剖切盒
    expect(primitives[2]!.length).toBe(3 * 4 * 18 * 8); // gizmo 箭头
    expect(primitives[3]!.length).toBe(5 * 18 * 8); // 测量线段
    expect(primitives[4]!.length).toBeGreaterThan(5 * 18 * 8); // 角度圆弧
    expect(primitives[4]!.length % (18 * 8)).toBe(0);
  });

  it("skips absent selection boxes, hidden gizmos and degenerate segments without producing holes", () => {
    const primitives = collectDeepOverlayPrimitives(viewer({
      getDeepSelectionBox: () => undefined,
      getDeepTransformGizmoInput: () => undefined,
      getDeepMeasurementSegmentInputs: () => [{ a: new THREE.Vector3(0, 0, 0), b: new THREE.Vector3(0, 0, 0), preview: true }],
    }), 128, 128, 1);
    expect(primitives).toHaveLength(1);
    expect(primitives[0]).toHaveLength(0);
  });
});
