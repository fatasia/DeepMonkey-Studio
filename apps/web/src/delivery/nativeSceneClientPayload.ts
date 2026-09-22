import type { SceneSnapshot } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { browserImageDecoder } from "./browserImageDecoder";
import { compileSceneRuntimePackage, type SceneIrradianceProbeBake } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";

/** F3 探针网格烘焙透传选项；缺省不携带探针，包语义与历史一致。 */
export interface NativeSceneClientPayloadOptions {
  readonly irradianceProbes?: SceneIrradianceProbeBake | null;
}

/** 构建产物与发布可用性分别记录；没有窗口验证证据的产物仍为blocked。 */
export async function prepareNativeSceneClientPayload(scene: SceneSnapshot,
  loadModel: (assetId: string, signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal,
  options?: NativeSceneClientPayloadOptions) {
  const compiled = await compileSceneRuntimePackage(scene, {
    packageId: `scene.${runtimeContentSha256(scene.id)}`, packageVersion: "1.0.0",
    loadModel, signal, imageDecoder: browserImageDecoder,
    ...(options?.irradianceProbes ? { irradianceProbes: options.irradianceProbes } : {}),
  });
  signal.throwIfAborted();
  const report = assessCompiledScenePublication(scene, { compilation: compiled.evidence,
    fixtureId: `scene-${compiled.evidence.sourceSemanticHash}`, platform: "windows-x64" });
  return {
    report,
    manifest: { kind: "deep-engine.runtime-package", schemaVersion: compiled.runtimePackage.schemaVersion,
      path: "native/runtime-package.json", packageHash: compiled.runtimePackage.packageHash,
      status: report.status, reportPath: "native/compatibility-report.json",
      degradedCapabilities: report.items.filter(item => item.status === "degraded").map(item => item.path).sort() },
    files: [
      { path: "native/runtime-package.json", content: compiled.packageJson },
      { path: "native/compilation-evidence.json", content: JSON.stringify(compiled.evidence, null, 2) },
      { path: "native/compatibility-report.json", content: JSON.stringify(report, null, 2) },
    ],
  };
}
