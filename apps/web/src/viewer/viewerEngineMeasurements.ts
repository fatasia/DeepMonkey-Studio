import * as THREE from "three";
import type { MeasurementState } from "@bim-studio/contracts";
import { createMeasurementVisual } from "./sceneOverlayVisuals";
import { ViewerEngineLoading } from "./viewerEngineLoading";

/** 测量证据的呈现、清理和定位，与相机导航策略保持解耦。 */
export abstract class ViewerEngineMeasurements extends ViewerEngineLoading {
  addMeasurementVisual(measurement: MeasurementState): void {
    const group = createMeasurementVisual(measurement, false);
    group.name = `measurement:${measurement.id}`;
    group.userData.measurement = measurement;
    this.scene.add(group);
  }

  clearMeasurements(): void {
    const objects = this.scene.children.filter((child) => child.name.startsWith("measurement:"));
    for (const object of objects) this.disposeObject(object);
  }

  deleteMeasurement(id: string): void {
    const object = this.scene.getObjectByName(`measurement:${id}`);
    if (object) this.disposeObject(object);
  }

  focusMeasurement(measurement: MeasurementState): void {
    const points = measurement.points?.length ? measurement.points : [measurement.start, measurement.end];
    const box = new THREE.Box3().setFromPoints(
      points.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
    );
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(size * 2.3));
    this.orbit.update();
  }
}
