import { BufferAttribute, BufferGeometry, CircleGeometry, Color, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, type Object3D } from "three";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import { disposeViewerObject } from "./sceneOverlayVisuals";

export interface ScenePlantPalette { waiting: Color; moving: Color; completed: Color }

/** 只呈现当前采样物料；不执行队列仿真，也不由绘制帧数累计“热度”。 */
export function createScenePlantSpatialLayers(scene: Object3D, model: PlantLiteModel, palette: ScenePlantPalette) {
  const anchors = new Map(model.sceneBinding?.nodes.map(node => [node.nodeId, node.position]));
  const root = new Group(); root.name = "helper:simulation-spatial"; root.visible = false;
  const heat = new Map<string, Mesh<CircleGeometry, MeshBasicMaterial>>();
  for (const [id, anchor] of anchors) {
    const disc = new Mesh(new CircleGeometry(1, 32), new MeshBasicMaterial({ color: palette.waiting, transparent: true, opacity: .2, depthTest: false, depthWrite: false }));
    disc.name = `helper:simulation-waiting:${id}`;
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(anchor[0], anchor[1] + .05, anchor[2]);
    disc.visible = false; disc.renderOrder = 35; disc.raycast = () => {};
    heat.set(id, disc); root.add(disc);
  }
  const positions = new Float32Array(18 * 2 * 3);
  const geometry = new BufferGeometry(); geometry.setAttribute("position", new BufferAttribute(positions, 3)); geometry.setDrawRange(0, 0);
  const trails = new LineSegments(geometry, new LineBasicMaterial({ color: palette.moving, depthTest: false, depthWrite: false, transparent: true, opacity: .85 }));
  trails.name = "helper:simulation-transport-trails"; trails.frustumCulled = false; trails.renderOrder = 36; trails.raycast = () => {};
  root.add(trails); scene.add(root);
  return {
    setPalette(next: ScenePlantPalette) {
      for (const disc of heat.values()) disc.material.color.copy(next.waiting);
      trails.material.color.copy(next.moving);
    },
    update(frame: PlantLitePlaybackFrame | null) {
      root.visible = Boolean(frame && (frame.sceneLayers?.heatmap || frame.sceneLayers?.trails));
      for (const [id, disc] of heat) {
        const count = frame?.waitingByNode?.[id] ?? 0;
        disc.visible = Boolean(frame?.sceneLayers?.heatmap && Number.isFinite(count) && count > 0);
        if (disc.visible) {
          const radius = Math.min(1.8, .35 + Math.sqrt(count) * .22);
          disc.scale.setScalar(radius); disc.material.opacity = Math.min(.65, .2 + count * .035);
          disc.userData.waitingSampleCount = count;
        } else delete disc.userData.waitingSampleCount;
      }
      let count = 0;
      if (frame?.sceneLayers?.trails) for (const item of frame.items) {
        const from = anchors.get(item.nodeId), to = item.transport && anchors.get(item.transport.toNodeId);
        if (!from || !to || count >= 18) continue;
        const progress = Math.max(0, Math.min(1, item.transport!.progress));
        if (!Number.isFinite(progress) || progress <= 0) continue;
        positions.set([from[0], from[1] + .25, from[2],
          from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress + .25,
          from[2] + (to[2] - from[2]) * progress], count * 6);
        count += 1;
      }
      geometry.setDrawRange(0, count * 2); geometry.getAttribute("position").needsUpdate = true;
    },
    dispose() { disposeViewerObject(root); },
  };
}
