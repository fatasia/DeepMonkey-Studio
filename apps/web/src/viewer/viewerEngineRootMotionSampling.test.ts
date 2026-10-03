import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { isIdentityRotation, sampleCycleCorrectedDelta } from "./viewerEngineRootMotionSampling";

function interpolantOf(track: THREE.KeyframeTrack): THREE.Interpolant {
  return (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
}

describe("viewerEngineRootMotionSampling", () => {
  const yaw = (angle: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
  const position = interpolantOf(new THREE.VectorKeyframeTrack("n.position", [0, 1], [0, 0, 0, 2, 0, 0]));
  const rotation = interpolantOf(new THREE.QuaternionKeyframeTrack("n.quaternion", [0, 1], [...yaw(0).toArray(), ...yaw(Math.PI).toArray()]));

  it("回绕时段采样求和:跨圈位移/旋转与未回绕线性量一致", () => {
    const translation = new THREE.Vector3();
    const delta = new THREE.Quaternion();
    sampleCycleCorrectedDelta(position, rotation, 0.75, 2.25, 1, translation, delta);
    expect(translation.x).toBeCloseTo(3, 6);
    expect(delta.angleTo(yaw(Math.PI * 1.5))).toBeCloseTo(0, 5);
  });

  it("空区间与空轨道返回零/单位增量", () => {
    const translation = new THREE.Vector3();
    const delta = new THREE.Quaternion();
    sampleCycleCorrectedDelta(null, null, 0.4, 0.4, 1, translation, delta);
    expect(translation.length()).toBe(0);
    expect(isIdentityRotation(delta)).toBe(true);
    expect(isIdentityRotation(yaw(0.01))).toBe(false);
  });
});
