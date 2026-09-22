import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { runtimeContentSha256 } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { assessCompiledScenePublication } from "../apps/web/src/delivery/scenePublicationCompatibility.ts";
import { compileSceneRuntimePackage } from "../apps/web/src/delivery/compileSceneRuntimePackage.ts";
import { prefilterNativeHdr } from "./lib/nativeHdrPrefilter.mjs";
import { createHash } from "node:crypto";
import { normalizeNativeSceneDraco } from "./lib/nativeSceneDraco.mjs";

const { scene, models, packageId, packageVersion, maxSourceBytes } = workerData;
const assets = new Map(models);
try {
  const hdr=workerData.hdrSource;
  const hdrEnvironment=hdr && !workerData.assessmentOnly ? {payload:await prefilterNativeHdr(hdr.bytes,workerData.nativeExecutable,hdr.license,undefined,scene.environment?.environmentIntensity ?? 1),source:{bytes:hdr.bytes.length,sha256:createHash("sha256").update(hdr.bytes).digest("hex")}} : undefined;
  const result = workerData.assessmentOnly ? workerData.compiled : await compileSceneRuntimePackage(scene, { packageId: packageId ?? `scene.${runtimeContentSha256(scene.id)}`, packageVersion: packageVersion ?? "1.0.0", maxSourceBytes,
    ...(hdrEnvironment ? {hdrEnvironment} : {}),
    normalizeModel: normalizeNativeSceneDraco,
    loadModel: async id => {
      const bytes = assets.get(id);
      if (!bytes) throw new Error(`冻结模型缺失：${id}`);
      return bytes;
    }, imageDecoder: { async decode(image) {
      const { data, info } = await sharp(image.data, { limitInputPixels: 16_777_216, failOn: "error" })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), width: info.width, height: info.height };
    } } });
  const report = assessCompiledScenePublication(scene, { compilation: result.evidence, fixtureId: `scene-${result.evidence.sourceSemanticHash}`, platform: "windows-x64",
    ...(workerData.assessmentOnly ? { runtimeEvidence: workerData.runtimeEvidence } : {}) });
  parentPort.postMessage({ protocol: "native-scene-candidate-v1", ok: true, packageJson: result.packageJson, evidence: result.evidence, report });
} catch (error) { parentPort.postMessage({ protocol: "native-scene-candidate-v1", ok: false, error: error instanceof Error ? error.message : String(error) }); }
