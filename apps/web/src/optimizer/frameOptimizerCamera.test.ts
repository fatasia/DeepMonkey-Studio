import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { frameOptimizerCamera } from "./frameOptimizerCamera";

describe("optimizer camera framing", () => {
  it.each([[1, 2, 20], [20, 2, 1], [0.01, 0.1, 0.02]])("fits every corner for oblique %j models", (x, y, z) => {
    for (const aspect of [0.5, 1.3, 2]) {
      const box = new THREE.Box3(new THREE.Vector3(-x, -y, -z), new THREE.Vector3(x, y, z));
      const camera = new THREE.PerspectiveCamera(48, aspect);
      camera.position.set(5, 4, 5);
      const target = new THREE.Vector3();
      frameOptimizerCamera({ modelBounds: box, camera, controls: { target, update: () => { camera.lookAt(target); camera.updateMatrixWorld(); } } });
      for (const cx of [-x, x]) for (const cy of [-y, y]) for (const cz of [-z, z]) {
        const projected = new THREE.Vector3(cx, cy, cz).project(camera);
        expect(Math.abs(projected.x)).toBeLessThan(0.9);
        expect(Math.abs(projected.y)).toBeLessThan(0.9);
        expect(Math.abs(projected.z)).toBeLessThan(1);
      }
    }
  });
});
