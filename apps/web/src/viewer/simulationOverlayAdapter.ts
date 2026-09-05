import { BufferGeometry, Group, Line, LineBasicMaterial, Vector3, type Object3D } from "three";
import type { SimulationOverlayPort } from "../simulation/sceneSimulationOverlay";
import { disposeViewerObject } from "./sceneOverlayVisuals";

/** 复用覆盖层释放与 helper 隔离约定，不进入 modelRoot、拾取、场景快照和 GLB 导出。 */
export function createSimulationOverlayAdapter(scene: Object3D): SimulationOverlayPort {
  let root: Group | undefined;
  function clear() {
    if (root) disposeViewerObject(root);
    root = undefined;
  }
  return {
    clear,
    replacePaths(paths) {
      clear();
      if (!paths.length) return;
      root = new Group();
      root.name = "helper:simulation-paths";
      for (const path of paths) {
        const line = new Line(
          new BufferGeometry().setFromPoints(path.points.map((point) => new Vector3(...point))),
          new LineBasicMaterial({ color: path.kind === "path" ? "#39c6be" : "#d4a84f", depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }),
        );
        line.name = `helper:simulation:${path.id}`;
        line.renderOrder = 30;
        line.raycast = () => {};
        root.add(line);
      }
      scene.add(root);
    },
  };
}
