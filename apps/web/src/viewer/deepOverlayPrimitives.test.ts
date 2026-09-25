import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { mergeDeepOverlayVertices, projectDeepMeasurementAngle, projectDeepMeasurementSegment, projectDeepSelectionBox,
  projectDeepTransformGizmo } from "./deepOverlayPrimitives";
import { OVERLAY_VERTEX_LIMIT } from "./studioDeepOverlayGeometry";

const headOnCamera = () => { const value = new THREE.PerspectiveCamera(60, 1, 0.1, 100); value.position.z = 3; value.updateMatrixWorld(true); return value; };
/** 三轴都不与视线平行的 3/4 视角,保证箭头杆不投影成零长度点。 */
const orbitCamera = () => {
  const value = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  value.position.set(4, 3, 4);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
};
const unitBox = () => new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
/** 线段中心色带顶点(每条线 18 顶点中的第 3 个):位置 4 floats + RGBA 4 floats。 */
const lineCenterColor = (vertices: Float32Array, line = 0) => ({
  r: vertices[line * 144 + 20]!, g: vertices[line * 144 + 21]!, b: vertices[line * 144 + 22]!, a: vertices[line * 144 + 23]!,
});
/** overlayLine 发射的顶点已是 NDC(x,y,0,1),直接按分量统计。 */
const componentValues = (vertices: Float32Array, component: 0 | 1): number[] => {
  const values: number[] = [];
  for (let offset = component; offset < vertices.length; offset += 8) values.push(vertices[offset]!);
  return values;
};
const ndcExtent = (vertices: Float32Array, component: 0 | 1): number => {
  const values = componentValues(vertices, component);
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
};
const ndcCenter = (vertices: Float32Array, component: 0 | 1): number => {
  const values = componentValues(vertices, component);
  return values.length ? (Math.max(...values) + Math.min(...values)) / 2 : 0;
};

describe("deep overlay selection box primitive", () => {
  it("emits 12 edges in the overlay vertex format with the selection color contract", () => {
    const vertices = projectDeepSelectionBox(unitBox(), headOnCamera(), 128, 128, 1);
    expect(vertices.length).toBe(12 * 18 * 8);
    const color = lineCenterColor(vertices);
    // 0x2684ff 的 sRGB 显示值 + Box3Helper 透明度合同。
    expect(color.r).toBeCloseTo(0x26 / 255, 4);
    expect(color.g).toBeCloseTo(0x84 / 255, 4);
    expect(color.b).toBeCloseTo(1, 4);
    expect(color.a).toBeCloseTo(0.95, 5);
    expect([...vertices].every(Number.isFinite)).toBe(true);
  });

  it("fails closed on empty boxes, non-finite corners and invalid viewports", () => {
    expect(projectDeepSelectionBox(new THREE.Box3(), headOnCamera(), 128, 128, 1)).toHaveLength(0);
    const broken = new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 1, 1));
    expect(() => projectDeepSelectionBox(broken, headOnCamera(), 128, 128, 1)).toThrow("finite");
    expect(() => projectDeepSelectionBox(unitBox(), headOnCamera(), 0, 128, 1)).toThrow("viewport");
  });

  it("drops lines fully behind the camera and keeps clipped ones finite", () => {
    const behind = new THREE.Box3(new THREE.Vector3(-1, -1, 5), new THREE.Vector3(1, 1, 6));
    expect(projectDeepSelectionBox(behind, headOnCamera(), 128, 128, 1)).toHaveLength(0);
    const crossing = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 4));
    const vertices = projectDeepSelectionBox(crossing, headOnCamera(), 128, 128, 1);
    expect(vertices.length).toBeGreaterThan(0);
    expect(vertices.length % 8).toBe(0);
    expect([...vertices].every(Number.isFinite)).toBe(true);
  });
});

describe("deep overlay measurement segment primitive", () => {
  const segment = (preview: boolean) => projectDeepMeasurementSegment(
    { a: new THREE.Vector3(-1, 0, 0), b: new THREE.Vector3(1, 0, 0), preview }, headOnCamera(), 128, 128, 1);

  it("emits the main line plus two cross ticks per endpoint with the measurement color contract", () => {
    const committed = segment(false);
    expect(committed.length).toBe(5 * 18 * 8);
    const color = lineCenterColor(committed);
    expect(color.r).toBeCloseTo(0xf6 / 255, 4);
    expect(color.a).toBe(1);
    const preview = segment(true);
    expect(lineCenterColor(preview).r).toBeCloseTo(0xf0 / 255, 4);
    expect(lineCenterColor(preview).a).toBeCloseTo(0.75, 5);
  });

  it("fails closed on zero-length segments and survives sight-parallel directions", () => {
    expect(projectDeepMeasurementSegment({ a: new THREE.Vector3(0, 0, 0), b: new THREE.Vector3(0, 0, 0), preview: false },
      headOnCamera(), 128, 128, 1)).toHaveLength(0);
    // 线段与视线平行时叉积基退化,回退正交基,输出保持有限。
    const sightParallel = projectDeepMeasurementSegment({ a: new THREE.Vector3(0, 0, 0), b: new THREE.Vector3(0, 0, 1), preview: false },
      headOnCamera(), 128, 128, 1);
    expect(sightParallel.length).toBeGreaterThan(0);
    expect([...sightParallel].every(Number.isFinite)).toBe(true);
    expect(() => projectDeepMeasurementSegment({ a: new THREE.Vector3(NaN, 0, 0), b: new THREE.Vector3(1, 0, 0), preview: false },
      headOnCamera(), 128, 128, 1)).toThrow("finite");
  });
});

describe("deep overlay angle measurement primitive", () => {
  it("emits two arms, endpoint ticks, and a finite circular arc", () => {
    const vertices = projectDeepMeasurementAngle({ points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 2, 0),
    ], preview: false }, headOnCamera(), 128, 128, 1);
    // 2 arms + 3 ticks + a clipped circular arc (up to 32 segments).
    expect(vertices.length).toBeGreaterThan(5 * 18 * 8);
    expect(vertices.length % (18 * 8)).toBe(0);
    expect([...vertices].every(Number.isFinite)).toBe(true);
  });

  it("fails closed on collinear or zero-length arms and validates points", () => {
    expect(projectDeepMeasurementAngle({ points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0),
    ], preview: false }, headOnCamera(), 128, 128, 1)).toHaveLength(0);
    expect(projectDeepMeasurementAngle({ points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0),
    ], preview: false }, headOnCamera(), 128, 128, 1)).toHaveLength(0);
    expect(() => projectDeepMeasurementAngle({ points: [
      new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
    ], preview: false }, headOnCamera(), 128, 128, 1)).toThrow("finite");
  });
});

describe("deep overlay transform gizmo primitive", () => {
  it("emits axis arrows for translate with the three.js axis color contract", () => {
    const vertices = projectDeepTransformGizmo({ matrix: new THREE.Matrix4(), mode: "translate" }, orbitCamera(), 128, 128, 1);
    expect(vertices.length).toBe(3 * 4 * 18 * 8);
    expect(lineCenterColor(vertices)).toMatchObject({ r: 1, g: 0, b: 0, a: 1 }); // X 红
    expect(lineCenterColor(vertices, 4)).toMatchObject({ r: 0, g: 1, b: 0, a: 1 }); // Y 绿
    expect(lineCenterColor(vertices, 8)).toMatchObject({ r: 0, g: 0, b: 1, a: 1 }); // Z 蓝
    expect([...vertices].every(Number.isFinite)).toBe(true);
  });

  it("follows the object world matrix and keeps a screen-constant size", () => {
    const identity = projectDeepTransformGizmo({ matrix: new THREE.Matrix4(), mode: "rotate" }, orbitCamera(), 128, 128, 1);
    expect(identity.length).toBe(3 * 48 * 18 * 8);
    // 屏幕等尺寸合同:gizmo 半径随相机距离缩放,远离一倍仍占相同 NDC 尺寸。
    const farther = projectDeepTransformGizmo({ matrix: new THREE.Matrix4().makeTranslation(-4, -3, -4), mode: "rotate" }, orbitCamera(), 128, 128, 1);
    expect(ndcExtent(farther, 0) / ndcExtent(identity, 0)).toBeCloseTo(1, 1);
    // 位置跟随:平移 (2,0,0) 后,环的 NDC 中心与该世界点的投影一致。
    const shifted = projectDeepTransformGizmo({ matrix: new THREE.Matrix4().makeTranslation(2, 0, 0), mode: "rotate" }, orbitCamera(), 128, 128, 1);
    const expected = new THREE.Vector3(2, 0, 0).project(orbitCamera());
    // 环的包围盒中心 ≈ 中心点投影(透视不对称在 2 位精度内)。
    expect(ndcCenter(shifted, 0)).toBeCloseTo(expected.x, 1);
    expect(ndcCenter(shifted, 1)).toBeCloseTo(expected.y, 1);
  });

  it("fails closed on non-finite matrices and degenerate axes", () => {
    expect(() => projectDeepTransformGizmo({ matrix: new THREE.Matrix4().makeTranslation(NaN, 0, 0), mode: "translate" },
      orbitCamera(), 128, 128, 1)).toThrow("finite");
    // 零缩放矩阵的轴向量退化 → 全部轴不产生顶点,输出为空而非泄漏零长度刻度线。
    const collapsed = projectDeepTransformGizmo({ matrix: new THREE.Matrix4().makeScale(0, 0, 0), mode: "translate" },
      orbitCamera(), 128, 128, 1);
    expect(collapsed).toHaveLength(0);
  });
});

describe("mergeDeepOverlayVertices", () => {
  it("appends primitives after the projected base and preserves order", () => {
    const base = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = new Float32Array(8).fill(9);
    const second = new Float32Array(16).fill(7);
    const merged = mergeDeepOverlayVertices(base, [first, second]);
    expect(merged.length).toBe(8 + 8 + 16);
    expect([...merged.slice(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(merged[8]).toBe(9);
    expect(merged[16]).toBe(7);
  });

  it("returns the base untouched without primitives and rejects partial vertices or budget overflow", () => {
    const base = new Float32Array(8);
    expect(mergeDeepOverlayVertices(base, [])).toBe(base);
    expect(() => mergeDeepOverlayVertices(new Float32Array(), [new Float32Array(9)])).toThrow("partial vertex");
    const nearLimit = new Float32Array(OVERLAY_VERTEX_LIMIT - 8);
    expect(() => mergeDeepOverlayVertices(nearLimit, [new Float32Array(16)])).toThrow("budget");
  });
});
