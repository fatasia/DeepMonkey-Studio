import { BufferAttribute, BufferGeometry, Color, Points, PointsMaterial, type Object3D } from "three";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import { disposeViewerObject } from "./sceneOverlayVisuals";
import { createScenePlantSpatialLayers, type ScenePlantPalette } from "./scenePlantSpatialLayers";

/** 网络模型使用已记录路段坐标；旧模型按场景端点插值。物料点不代表实体车模型。 */
export function createScenePlantPlaybackOverlay(scene: Object3D, model: PlantLiteModel, palette: ScenePlantPalette = { waiting: new Color(), moving: new Color(), completed: new Color() }) {
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
  const spatial = createScenePlantSpatialLayers(scene, model, palette);
  return {
    setPalette(next: ScenePlantPalette) { palette = next; spatial.setPalette(next); },
    update(frame: PlantLitePlaybackFrame | null) {
      spatial.update(frame);
      let count = 0;
      for (const item of frame?.items ?? []) {
        const position = item.worldPosition ?? anchors.get(item.nodeId);
        if (!position || count >= 18) continue;
        const target = !item.worldPosition && item.transport ? anchors.get(item.transport.toNodeId) : undefined;
        const progress = target ? Math.min(1, Math.max(0, item.transport?.progress ?? 0)) : 0;
        positions.set([
          position[0] + ((target?.[0] ?? position[0]) - position[0]) * progress,
          position[1] + ((target?.[1] ?? position[1]) - position[1]) * progress + .25 + item.lane * .12,
          position[2] + ((target?.[2] ?? position[2]) - position[2]) * progress,
        ], count * 3);
        const color = item.state === "queued" ? palette.waiting : item.state === "completed" ? palette.completed : palette.moving;
        colors.set([color.r, color.g, color.b], count * 3);
        count += 1;
      }
      geometry.setDrawRange(0, count);
      geometry.getAttribute("position").needsUpdate = true;
      geometry.getAttribute("color").needsUpdate = true;
    },
    dispose() { disposeViewerObject(points); spatial.dispose(); },
  };
}
