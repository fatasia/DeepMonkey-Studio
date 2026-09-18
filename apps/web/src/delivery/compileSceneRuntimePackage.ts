import type { SceneSnapshot } from "@bim-studio/contracts";
import { buildDeepRuntimePackage, runtimeContentSha256, serializeDeepRuntimePackage,
  type DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRenderPacket, type CompileSceneRenderOptions, type SceneRenderCompilation } from "./compileSceneRenderPacket";
import { compileSceneCamera } from "./compileSceneCamera";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { collectDeferredSceneFields, collectDeferredObjectFields } from "./sceneInactiveFields";
import { localizeSceneCoordinates, type SceneLocalCoordinateFrame } from "./sceneLocalCoordinates";

const RECIPE = "deep-scene-static-compile-v5";
export interface CompileSceneRuntimeOptions extends CompileSceneRenderOptions {
  readonly packageId: string;
  readonly packageVersion: string;
}
export interface SceneCompilationEvidence {
  readonly schemaVersion: 1;
  readonly scope: "static-render-packet";
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  /** 对 runtime/package.json 实际 UTF-8 字节计算，与包内 canonical hash 分开。 */
  readonly targetArtifactHash: string;
  readonly recipe: typeof RECIPE | "deep-scene-static-compile-v4";
  readonly localCoordinates: SceneLocalCoordinateFrame;
  readonly maxSourceBytes: number;
  readonly sourceAssets: readonly { assetId: string; bytes: number; sha256: string }[];
  readonly objectBindings: SceneRenderCompilation["objectBindings"];
  readonly compiledSceneFields: readonly { field: string; capability: string; resourceId: string }[];
  /** 尚未进入运行包的语义，正式发布门禁必须继续处理，不能直接放行。 */
  readonly deferredSceneFields: readonly string[];
  readonly deferredObjectFields: readonly { nodeId: string; fields: readonly string[] }[];
}
export interface CompiledSceneRuntime {
  readonly runtimePackage: DeepRuntimePackage;
  readonly packageJson: string;
  readonly evidence: SceneCompilationEvidence;
}

/** 生成可装载的静态 Runtime Package 与编译证据；不把未编译场景语义声明为支持。 */
export async function compileSceneRuntimePackage(input: SceneSnapshot,
  options: CompileSceneRuntimeOptions): Promise<CompiledSceneRuntime> {
  const scene = structuredClone(input);
  const { packageId, packageVersion, loadModel, imageDecoder, signal, maxSourceBytes } = options;
  signal?.throwIfAborted();
  const semantic = sceneCompilationSource(scene);
  const sourceSemanticHash = runtimeContentSha256(semantic);
  const localized = localizeSceneCoordinates(scene);
  const camera = compileSceneCamera(localized.scene, localized.frame);
  const sourceAssets: Array<{ assetId: string; bytes: number; sha256: string }> = [];
  let loadedBytes = 0;
  const compiled = await compileSceneRenderPacket(localized.scene, {
    ...(imageDecoder ? { imageDecoder } : {}), ...(signal ? { signal } : {}),
    ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }),
    async loadModel(assetId, loadSignal) {
      const loaded = await loadModel(assetId, loadSignal);
      loadSignal.throwIfAborted();
      loadedBytes += loaded.byteLength;
      if (loadedBytes > (maxSourceBytes ?? 256 * 1024 * 1024)) throw new Error(`模型资源 ${assetId} 超出场景预算`);
      const bytes = Uint8Array.from(loaded);
      sourceAssets.push({ assetId, bytes: bytes.byteLength, sha256: await byteHash(bytes) });
      loadSignal.throwIfAborted();
      return bytes;
    } });
  signal?.throwIfAborted();
  const runtimePackage = buildDeepRuntimePackage({ packageId, packageVersion, camera,
    renderPacket: { id: "scene.main", revision: 1, value: compiled.packet } });
  const packageJson = serializeDeepRuntimePackage(runtimePackage);
  sourceAssets.sort((a, b) => a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
  const compileGraphHash = runtimeContentSha256({ recipe: RECIPE, sourceSemanticHash, sourceAssets,
    packageId, packageVersion, maxSourceBytes: maxSourceBytes ?? 256 * 1024 * 1024,
    localCoordinates: localized.frame,
    cameraHash: runtimePackage.resources.find(resource => resource.kind === "scene-camera")!.contentHash.value,
    renderPacketHash: runtimePackage.resources.find(resource => resource.kind === "render-packet")!.contentHash.value });
  const targetArtifactHash = await byteHash(new TextEncoder().encode(packageJson));
  signal?.throwIfAborted();
  const deferredSceneFields = collectDeferredSceneFields(semantic);
  const deferredObjectFields = collectDeferredObjectFields(scene);
  return { runtimePackage, packageJson, evidence: { schemaVersion: 1, scope: "static-render-packet", recipe: RECIPE,
    localCoordinates: localized.frame, maxSourceBytes: maxSourceBytes ?? 256 * 1024 * 1024,
    sourceSemanticHash, compileGraphHash, targetArtifactHash, sourceAssets,
    objectBindings: compiled.objectBindings, compiledSceneFields: [{ field: "camera", capability: "deep.scene.camera.v1", resourceId: camera.id }],
    deferredSceneFields, deferredObjectFields } };
}

async function byteHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
