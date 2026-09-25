import { parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";
import { runtimeContentSha256 } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { assessCompiledScenePublication } from "../apps/web/src/delivery/scenePublicationCompatibility.ts";
import { compileSceneRuntimePackage } from "../apps/web/src/delivery/compileSceneRuntimePackage.ts";
import { probeGridBakeSourceHash } from "../apps/web/src/delivery/probeGridBakePublicationSession.ts";
import { prefilterNativeHdr } from "./lib/nativeHdrPrefilter.mjs";
import { createHash } from "node:crypto";
import { normalizeNativeSceneDraco } from "./lib/nativeSceneDraco.mjs";

const { scene, models, packageId, packageVersion, maxSourceBytes } = workerData;
const assets = new Map(models);

/**
 * F3 发布一致性：从服务端持久化候选中按"当前场景的编译器严格源投影哈希"挑选烘焙结果。
 * 与 UI 会话路径同一优先级语义（显式参数 > 服务端持久化 > 无）：本线程没有显式参数，
 * 持久化哈希与当前场景失配即不带，绝不注入陈旧烘焙。只解压命中的那份 gzip；
 * 解压/解析失败按降级处理（不带探针继续编译），不阻塞候选验证。
 */
function resolvePersistedIrradianceProbes(workerData) {
  const candidates = workerData.probeBakeCandidates;
  if (!Array.isArray(candidates) || candidates.length === 0 || workerData.assessmentOnly) return undefined;
  try {
    const sourceHash = probeGridBakeSourceHash(scene);
    const match = candidates.find(item => item && item.sourceHash === sourceHash);
    if (!match) return undefined;
    const document = JSON.parse(gunzipSync(Buffer.from(match.gzip)).toString("utf8"));
    return document && typeof document === "object" && document.bake && typeof document.bake === "object"
      && !Array.isArray(document.bake) ? document.bake : undefined;
  } catch (error) {
    console.warn(`[probe-bake] 持久化烘焙候选读取失败，按无探针处理：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const irradianceProbes = resolvePersistedIrradianceProbes(workerData);
try {
  const hdr=workerData.hdrSource;
  const hdrEnvironment=hdr && !workerData.assessmentOnly ? {payload:await prefilterNativeHdr(hdr.bytes,workerData.nativeExecutable,hdr.license,undefined,scene.environment?.environmentIntensity ?? 1),source:{bytes:hdr.bytes.length,sha256:createHash("sha256").update(hdr.bytes).digest("hex")}} : undefined;
  const result = workerData.assessmentOnly ? workerData.compiled : await compileSceneRuntimePackage(scene, { packageId: packageId ?? `scene.${runtimeContentSha256(scene.id)}`, packageVersion: packageVersion ?? "1.0.0", maxSourceBytes,
    ...(hdrEnvironment ? {hdrEnvironment} : {}),
    ...(irradianceProbes ? {irradianceProbes} : {}),
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
