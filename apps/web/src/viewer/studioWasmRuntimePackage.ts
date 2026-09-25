import { getSceneModelAssetId, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { parseGlb } from "@bim-studio/deep-engine/gltf";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { compileSceneRuntimePackage } from "../delivery/compileSceneRuntimePackage";
import { probeGridBakeForPayload } from "../delivery/probeGridBakePublicationSession";
import { loadViewerAssetBuffer } from "./viewerAssetTransport";

/** Compile through the same runtime-package path used by Native publication. */
export async function compileStudioWasmRuntimePackage(
  scene: SceneSnapshot,
  project: ProjectRecord,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const compiled = await compileSceneRuntimePackage(scene, {
    packageId: `studio.${runtimeContentSha256(scene.id)}`,
    packageVersion: "1.0.0",
    // Share the publication session's strict scene-semantic key: restored bakes
    // flow to WASM through the same validated Runtime Package environment.
    irradianceProbes: probeGridBakeForPayload(scene) ?? null,
    signal,
    imageDecoder: browserImageDecoder,
    normalizeModel: normalizeStudioWasmModel,
    loadModel: async (assetId, loadSignal) => {
      loadSignal.throwIfAborted();
      const instance = scene.models.find((model) => getSceneModelAssetId(model) === assetId || model.modelId === assetId);
      const resolvedAssetId = instance ? getSceneModelAssetId(instance) : assetId;
      const model = project.models.find((candidate) => candidate.id === resolvedAssetId);
      const url = model?.manifest?.geometryUrl;
      if (!model || !url || model.status !== "ready") throw new Error(`WASM 编译缺少模型资源：${assetId}`);
      return new Uint8Array(await loadViewerAssetBuffer(url, model.name, { signal: loadSignal, timeoutMs: 120_000 }));
    },
  });
  signal.throwIfAborted();
  return new TextEncoder().encode(compiled.packageJson);
}

/** Browser counterpart of the existing Native candidate Draco normalization. */
export async function normalizeStudioWasmModel(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (bytes.byteLength < 20 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x46546c67) {
    return bytes;
  }
  const { json } = parseGlb(bytes);
  const document = json as { extensionsUsed?: unknown; extensionsRequired?: unknown };
  const declared = [...asStringArray(document.extensionsUsed), ...asStringArray(document.extensionsRequired)];
  if (!declared.includes("KHR_draco_mesh_compression")) return bytes;

  // Reuse the optimizer's pinned WebIO + Draco decoder; only the compression
  // extension is removed, while material semantics keep flowing through the
  // authoritative runtime-package compiler and its fail-closed validation.
  const { optimizerIO } = await import("../optimizer/modelOptimizerIO");
  const io = await optimizerIO();
  signal.throwIfAborted();
  const gltf = await io.readBinary(bytes);
  for (const extension of gltf.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  const normalized = await io.writeBinary(gltf);
  signal.throwIfAborted();
  return normalized;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
