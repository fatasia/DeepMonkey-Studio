import { BufferAttribute, BufferGeometry, Points, PointsMaterial, type Object3D } from "three";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import { disposeViewerObject } from "./sceneOverlayVisuals";

/** 真实 DES 事件位置；瞬时连线不伪造 AGV 行驶。固定缓冲区、无模型变换写入。 */
export function createScenePlantPlaybackOverlay(scene: Object3D, model: PlantLiteModel) {
  const anchors = new Map(model.sceneBinding?.nodes.map(node => [node.nodeId, node.position]));
  const positions = new Float32Array(18 * 3);
  const colors = new Float32Array(18 * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.setDrawRange(0, 0);
  const points = new Points(geometry, new PointsMaterial({ size: 13, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false }));
  points.name = "helper:simulation-playback";
  points.raycast = () => {};
  points.frustumCulled = false;
  points.renderOrder = 40;
  scene.add(points);
  return {
    update(frame: PlantLitePlaybackFrame | null) {
      let count = 0;
      for (const item of frame?.items ?? []) {
        const position = anchors.get(item.nodeId);
        if (!position || count >= 18) continue;
        positions.set([position[0], position[1] + .25 + item.lane * .12, position[2]], count * 3);
        colors.set(item.state === "queued" ? [1, .65, .2] : item.state === "completed" ? [.3, .85, .5] : [.2, .8, .9], count * 3);
        count += 1;
      }
      geometry.setDrawRange(0, count);
      geometry.getAttribute("position").needsUpdate = true;
      geometry.getAttribute("color").needsUpdate = true;
    },
    dispose() { disposeViewerObject(points); },
  };
}
