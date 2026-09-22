import { tagGltfMaterialSlots } from "./materialSlots";
import { FileLoader, LoaderUtils } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { hasLegacySpecGloss } from "./gltfLegacyMaterialDetection";

/** Modern glTF takes the original loader path; only the deprecated material workflow is converted. */
export class CompatibleGLTFLoader extends GLTFLoader {
  override parse(data: ArrayBuffer | string, path: string, onLoad: (gltf: GLTF) => void, onError?: (event: ErrorEvent) => void): void {
    const loaded = (gltf: GLTF) => { tagGltfMaterialSlots(gltf); onLoad(gltf); };
    let legacy: boolean;
    try { legacy = hasLegacySpecGloss(data); }
    catch { super.parse(data, path, loaded, onError); return; }
    if (!legacy) { super.parse(data, path, loaded, onError); return; }
    void import("../optimizer/legacyGltfMaterials").then(async ({ legacyGltfForRendering }) => {
      const resourceLoader = new FileLoader(this.manager).setResponseType("arraybuffer")
        .setRequestHeader(this.requestHeader).setWithCredentials(this.withCredentials);
      const migrated = await legacyGltfForRendering(data, async uri =>
        await resourceLoader.loadAsync(LoaderUtils.resolveURL(uri, path)) as ArrayBuffer);
      super.parse(migrated, path, loaded, onError);
    }).catch(error => {
      if (onError) onError(error as ErrorEvent);
      else console.error("旧版 glTF 材质无法转换", error);
    });
  }
}
