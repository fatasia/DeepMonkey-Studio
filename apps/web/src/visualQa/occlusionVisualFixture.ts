import * as THREE from "three";
import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 固定实体墙/密集设备，同时保留侧面的可见设备和地面投影。 */
export function populateOcclusionVisualFixture(engine: ViewerEngine, count: number, cycle = 0): void {
  engine.setSceneEnvironment({ gridVisible: true, backgroundColor: "#11191d", skybox: "none" });
  engine.createPrimitive("qa-wall", "实体墙", "box", "#667985", new THREE.Vector3(0, 5, -5));
  engine.setModelTransform("qa-wall", { scale: [5, 5, 0.5], rotation: [0, cycle % 2 ? 0.2 : 0, 0] });
  for (let index = 0; index < count; index++) {
    const id = `qa-occluded-${index}`;
    engine.createPrimitive(id, `墙后设备 ${index + 1}`, "sphere", "#d6a94c", new THREE.Vector3((index % 10 - 4.5) * 0.65, 1 + Math.floor(index / 10) % 10 * 0.7, -9 - Math.floor(index / 100) * 2));
    engine.setModelTransform(id, { scale: [0.3, 0.3, 0.3] });
  }
  engine.createPrimitive("qa-visible-equipment", "侧面可见设备", "torus", "#54a994", new THREE.Vector3(7, 1, -4));
  engine.setCameraPose({ position: [0, 5, 12], target: [0, 5, -5], near: 0.1, far: 250, fov: 48 });
  engine.select(undefined);
}
