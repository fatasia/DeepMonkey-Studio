import { getSceneModelAssetId, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { normalizeStudioWasmModel } from "./normalizeStudioModel";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { compileSceneRuntimePackage, type SceneIrradianceProbeBake } from "../delivery/compileSceneRuntimePackage";
import { probeGridBakeForPayload } from "../delivery/probeGridBakePublicationSession";
import { loadViewerAssetBuffer } from "./viewerAssetTransport";
import type { StudioWasmCompilationProgress } from "./studioWasmCompilationClient";

/** Compile through the same runtime-package path used by Native publication. */
export async function compileStudioWasmRuntimePackageInProcess(
  scene: SceneSnapshot,
  project: Pick<ProjectRecord, "models">,
  signal: AbortSignal,
  irradianceProbes: SceneIrradianceProbeBake | null = probeGridBakeForPayload(scene) ?? null,
  onProgress?: (progress: StudioWasmCompilationProgress) => void,
): Promise<Uint8Array> {
  const progress = (stage: StudioWasmCompilationProgress["stage"]) => {
    signal.throwIfAborted(); onProgress?.({ kind: "progress", stage });
  };
  progress("starting");
  const compiled = await compileSceneRuntimePackage(scene, {
    packageId: `studio.${runtimeContentSha256(scene.id)}`,
    packageVersion: "1.0.0",
    // Share the publication session's strict scene-semantic key: restored bakes
    // flow to WASM through the same validated Runtime Package environment.
    irradianceProbes,
    signal,
    imageDecoder: { decode: (...args) => { progress("textures"); return browserImageDecoder.decode(...args); } },
    textureBudgetBytes: 112 * 1024 * 1024,
    advancedMaterials: true,
    onPackageBuild: () => progress("package"),
    loadTexture: async (url, loadSignal) => {
      progress("assets");
      return new Uint8Array(await loadViewerAssetBuffer(url, "材质贴图", { signal: loadSignal, timeoutMs: 120_000 }));
    },
    normalizeModel: (bytes, loadSignal) => { progress("geometry"); return normalizeStudioWasmModel(bytes, loadSignal); },
    loadModel: async (assetId, loadSignal) => {
      loadSignal.throwIfAborted();
      progress("assets");
      const instance = scene.models.find((model) => getSceneModelAssetId(model) === assetId || model.modelId === assetId);
      const resolvedAssetId = instance ? getSceneModelAssetId(instance) : assetId;
      const model = project.models.find((candidate) => candidate.id === resolvedAssetId);
      const url = model?.manifest?.geometryUrl;
      if (!model || !url || model.status !== "ready") throw new Error(`WASM 编译缺少模型资源：${assetId}`);
      return new Uint8Array(await loadViewerAssetBuffer(url, model.name, { signal: loadSignal, timeoutMs: 120_000 }));
    },
  });
  signal.throwIfAborted();
  const bytes = new TextEncoder().encode(compiled.packageJson);
  progress("complete");
  return bytes;
}

