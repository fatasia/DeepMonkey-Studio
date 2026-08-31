import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { solveBoneChainIK } from "./ik";

describe("bone-chain IK", () => {
  it("moves a two-joint chain toward a world-space target", () => {
    const root = new THREE.Group();
    const shoulder = new THREE.Bone();
    const elbow = new THREE.Bone();
    const effector = new THREE.Bone();
    elbow.position.x = 1;
    effector.position.x = 1;
    root.add(shoulder);
    shoulder.add(elbow);
    elbow.add(effector);
    root.updateMatrixWorld(true);

    const residual = solveBoneChainIK(effector, new THREE.Vector3(0.2, 1.8, 0), { chainLength: 2, iterations: 24 });

    expect(residual).toBeLessThan(0.03);
    expect(effector.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThan(1.7);
  });
});
