import { getSceneModelAssetId, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { probeGridBakeForPayload } from "../delivery/probeGridBakePublicationSession";
import { runStudioWasmCompilation, type StudioWasmCompilationProgress, type StudioWasmCompiledPackage, type StudioDecodedAsset } from "./studioWasmCompilationClient";

export { normalizeStudioWasmModel } from "./normalizeStudioModel";

/** Keep canonical hashing, geometry compilation and validation off the author input thread. */
export async function compileStudioWasmRuntimePackage(scene: SceneSnapshot, project: ProjectRecord,
  signal: AbortSignal, options: { readonly decodedAssets?: readonly StudioDecodedAsset[]; readonly onProgress?: (progress: StudioWasmCompilationProgress) => void } = {}): Promise<StudioWasmCompiledPackage> {
  signal.throwIfAborted();
  if (typeof Worker === "undefined") throw new Error("浏览器不支持 WASM 后台编译，请升级浏览器或使用 Three 引擎。");
  const irradianceProbes = probeGridBakeForPayload(scene) ?? null;
  const ids = new Set(scene.models.flatMap(model => [getSceneModelAssetId(model), model.modelId]));
  const models = project.models.filter(model => ids.has(model.id)).map(({ id, name, status, manifest }) =>
    ({ id, name, status, ...(manifest ? { manifest } : {}) }));
  return runStudioWasmCompilation({ scene, models, irradianceProbes, ...(options.decodedAssets ? { decodedAssets: options.decodedAssets } : {}) }, signal,
    () => new Worker(new URL("./studioWasmCompilationWorker.ts", import.meta.url), { type: "module" }), options);
}
