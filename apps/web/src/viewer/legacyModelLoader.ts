import * as THREE from "three";
import type { ViewerKind } from "@bim-studio/contracts";
import { loadViewerAssetBuffer, loadViewerAssetText } from "./viewerAssetTransport";

export type LegacyViewerKind = Extract<ViewerKind, "obj" | "stl" | "3mf" | "dae" | "3ds">;

export interface LegacyModelLoadResult {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

/**
 * 按需加载开放交换格式。加载器与对应格式代码不会进入常规 glTF/IFC 首屏，
 * 同时所有资源仍经过统一的 Viewer 资产读取边界。
 */
export async function loadLegacyModel(kind: LegacyViewerKind, url: string): Promise<LegacyModelLoadResult> {
  switch (kind) {
    case "obj": {
      const [{ OBJLoader }, source] = await Promise.all([
        import("three/examples/jsm/loaders/OBJLoader.js"),
        loadViewerAssetText(url, "OBJ"),
      ]);
      return { object: new OBJLoader().parse(source), animations: [] };
    }
    case "stl": {
      const [{ STLLoader }, source] = await Promise.all([
        import("three/examples/jsm/loaders/STLLoader.js"),
        loadViewerAssetBuffer(url, "STL"),
      ]);
      const geometry = new STLLoader().parse(source);
      const material = new THREE.MeshStandardMaterial({ color: 0xb7c1cc, metalness: 0.05, roughness: 0.65 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "STL 模型";
      return { object: mesh, animations: [] };
    }
    case "3mf": {
      const [{ ThreeMFLoader }, source] = await Promise.all([
        import("three/examples/jsm/loaders/3MFLoader.js"),
        loadViewerAssetBuffer(url, "3MF"),
      ]);
      return { object: new ThreeMFLoader().parse(source), animations: [] };
    }
    case "dae": {
      const [{ ColladaLoader }, source] = await Promise.all([
        import("three/examples/jsm/loaders/ColladaLoader.js"),
        loadViewerAssetText(url, "DAE"),
      ]);
      const collada = new ColladaLoader().parse(source, resourceBase(url));
      if (!collada) throw new Error("DAE 文件没有可加载的场景");
      return { object: collada.scene, animations: collada.scene.animations };
    }
    case "3ds": {
      const [{ TDSLoader }, source] = await Promise.all([
        import("three/examples/jsm/loaders/TDSLoader.js"),
        loadViewerAssetBuffer(url, "3DS"),
      ]);
      return { object: new TDSLoader().parse(source, resourceBase(url)), animations: [] };
    }
  }
}

function resourceBase(url: string): string {
  const index = url.lastIndexOf("/");
  return index >= 0 ? url.slice(0, index + 1) : "";
}
