import type { ScenePublicationDependencies, SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { api } from "../api";
import type { SceneCompilationEvidence } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";
import { assertScenePublicationDeliverable } from "./scenePublicationCompatibilityGate";
import { assertFrozenNativeCompiled, frozenSceneResourceUrl } from "./sceneClientFrozenDependencies";
import { compileSceneCamera } from "./compileSceneCamera";
import { localizeSceneCoordinates } from "./sceneLocalCoordinates";

/** 历史包复用服务器已验证的精确编译字节；这里不再解码图片或编译几何。 */
export async function prepareFrozenNativeScenePayload(input: SceneSnapshot, dependencies: ScenePublicationDependencies, signal: AbortSignal) {
  const scene = structuredClone(input), record = structuredClone(dependencies);
  signal.throwIfAborted(); assertFrozenNativeCompiled(record);
  const native = record.nativeCompiled;
  if (!native || scene.id !== record.sceneId || scene.projectId !== record.projectId) throw new Error("缺少该场景的冻结 Native 编译产物");
  const content = await api.loadScenePublicationResource(frozenSceneResourceUrl(record, native.runtimePackage.sha256), native.runtimePackage.bytes, signal);
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", content);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (content.byteLength !== native.runtimePackage.bytes || hash !== native.runtimePackage.sha256) throw new Error("冻结 Native 编译字节校验失败");
  const packageJson = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parsed = parseDeepRuntimePackage(packageJson);
  if (!parsed.valid || parsed.value.schemaVersion !== 3) throw new Error("冻结 Native 运行包校验失败");
  const runtime = parsed.value, compilation = native.compilationEvidence as unknown as SceneCompilationEvidence;
  const report = assessCompiledScenePublication(scene, { compilation, runtimeEvidence: native.compatibilityReport.evidence,
    fixtureId: native.compatibilityReport.fixtureId, platform: native.compatibilityReport.platform });
  assertScenePublicationDeliverable(report);
  const cameraHash = runtime.resources.find(resource => resource.kind === "scene-camera")?.contentHash.value;
  const renderPacketHash = runtime.resources.find(resource => resource.kind === "render-packet")?.contentHash.value;
  if (!cameraHash || !renderPacketHash || compilation.compileGraphHash !== runtimeContentSha256({
    recipe: compilation.recipe, sourceSemanticHash: compilation.sourceSemanticHash, sourceAssets: compilation.sourceAssets,
    packageId: runtime.packageId, packageVersion: runtime.packageVersion, maxSourceBytes: compilation.maxSourceBytes,
    localCoordinates: compilation.localCoordinates, cameraHash, renderPacketHash,
  })) throw new Error("冻结 Native 编译图身份不一致");
  const localized = localizeSceneCoordinates(scene);
  const camera = compileSceneCamera(localized.scene, compilation.recipe === "deep-scene-static-compile-v5" ? localized.frame : undefined);
  if (runtimeContentSha256(runtime.payloads[runtime.entrypoints.camera!]) !== runtimeContentSha256(camera)) throw new Error("冻结 Native 相机与保存场景不一致");
  signal.throwIfAborted();
  return { report,
    manifest: { kind: "deep-engine.runtime-package", schemaVersion: runtime.schemaVersion, path: "native/runtime-package.json",
      packageHash: runtime.packageHash, status: report.status, reportPath: "native/compatibility-report.json" },
    files: [{ path: "native/runtime-package.json", content: packageJson },
      { path: "native/compilation-evidence.json", content: JSON.stringify(compilation, null, 2) },
      { path: "native/compatibility-report.json", content: JSON.stringify(report, null, 2) }] };
}
