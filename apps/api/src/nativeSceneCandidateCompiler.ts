import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { SceneSnapshot, ScenePublicationCompatibilityReport, PublicationCapabilityEvidence } from "@bim-studio/contracts";

export interface NativeSceneCandidateInput {
  scene: SceneSnapshot;
  models: ReadonlyMap<string, Uint8Array>;
  hdrSource?:{bytes:Uint8Array;license:string};
  nativeExecutable?:string;
  packageId?: string;
  packageVersion?: string;
  maxSourceBytes?: number;
  signal?: AbortSignal;
}
export interface NativeSceneCandidate {
  packageJson: string;
  evidence: Record<string, unknown>;
  compilerSha256: string;
  report: ScenePublicationCompatibilityReport;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 目录属于服务启动配置，不来自编译请求；测试使用独立构建目录。 */
export function createNativeSceneCandidateCompiler(directory = new URL("../dist/native-scene-compiler/", import.meta.url)) {
  return (input: NativeSceneCandidateInput) => compileCandidate(input, directory);
}
export const compileNativeSceneCandidate = createNativeSceneCandidateCompiler();
export interface VerifiedNativeSceneCandidateInput {
  scene: SceneSnapshot;
  compiled: NativeSceneCandidate;
  runtimeEvidence: readonly PublicationCapabilityEvidence[];
  signal?: AbortSignal;
}
/** 仅供服务端窗口验证之后复核，不接受 HTTP 自报证据。 */
export function createVerifiedNativeSceneCandidateAssessor(directory = new URL("../dist/native-scene-compiler/", import.meta.url)) {
  return async (input: VerifiedNativeSceneCandidateInput): Promise<ScenePublicationCompatibilityReport> => {
    const result = await compileCandidate({ scene: input.scene, models: new Map(), ...(input.signal ? { signal: input.signal } : {}) }, directory,
      { compiled: structuredClone(input.compiled), runtimeEvidence: structuredClone(input.runtimeEvidence) });
    return result.report;
  };
}
export const assessVerifiedNativeSceneCandidate = createVerifiedNativeSceneCandidateAssessor();

/** 固定构建产物在独立线程运行；只使用服务端提供的冻结字节。 */
async function compileCandidate(input: NativeSceneCandidateInput, directory: URL, assessment?: Pick<VerifiedNativeSceneCandidateInput, "compiled" | "runtimeEvidence">): Promise<NativeSceneCandidate> {
  input.signal?.throwIfAborted();
  const maxSourceBytes = input.maxSourceBytes ?? 256 * 1024 ** 2;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > 256 * 1024 ** 2) throw new Error("候选资源预算无效");
  const scene = structuredClone(input.scene), models: Array<[string, Uint8Array]> = [];
  let bytes = 0;
  for (const [id, value] of input.models) {
    bytes += value.byteLength;
    if (!id.trim() || bytes > maxSourceBytes) throw new Error("候选资源缺少身份或超出预算");
    models.push([id, Uint8Array.from(value)]);
  }
  // src 与 dist 使用同一个部署产物；缺失时不在请求期间构建或读取 Web 源码。
  let module: Buffer, manifest: { schemaVersion: number; compilerSha256: string };
  try {
    [module, manifest] = await Promise.all([readFile(new URL("compiler.mjs", directory)),
      readFile(new URL("manifest.json", directory), "utf8").then(value => JSON.parse(value))]);
  } catch { throw new Error("Native 候选编译器不可用，请先构建 API 编译产物"); }
  const compilerSha256 = hash(module);
  if (assessment && (assessment.compiled.compilerSha256 !== compilerSha256
    || hash(Buffer.from(assessment.compiled.packageJson)) !== assessment.compiled.evidence.targetArtifactHash)) throw new Error("待复核编译器或产物身份已变化");
  if (manifest.schemaVersion !== 1 || manifest.compilerSha256 !== compilerSha256) throw new Error("Native 候选编译器内容校验失败");
  input.signal?.throwIfAborted();
  // 校验后从原字节启动，避免并行构建替换模块；sharp 由固定 API 路径解析。
  const require = createRequire(import.meta.url);
  const source = module.toString("utf8").replace(/from "(sharp|@gltf-transform\/core|@gltf-transform\/extensions|draco3dgltf)"/g,
    (_match, name: string) => `from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`), {
      workerData: { scene, models, packageId: input.packageId, packageVersion: input.packageVersion, maxSourceBytes,
        hdrSource:input.hdrSource,nativeExecutable:input.nativeExecutable,
        ...(assessment ? { assessmentOnly: true, ...assessment } : {}) },
      // 自包含产物不继承开发进程的 tsx/watch loader 或条件参数。
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let done = false;
    const finish = (error?: Error, value?: NativeSceneCandidate) => {
      if (done) return; done = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      void worker.terminate().then(() => { if (error) reject(error); else resolve(value!); }, reject);
    };
    const abort = () => finish(input.signal?.reason instanceof Error ? input.signal.reason : new Error("候选编译已取消"));
    const timer = setTimeout(() => finish(new Error("候选编译超过 60 秒限额")), 60_000);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    worker.once("error", error => finish(new Error(error.message.split(" imported from data:")[0])));
    worker.once("exit", () => { if (!done) finish(new Error("候选编译线程提前退出")); });
    worker.on("message", (result: { protocol?: string; ok: boolean; error?: string; packageJson: string; evidence: Record<string, unknown>; report: ScenePublicationCompatibilityReport }) => {
      if (!result || result.protocol !== "native-scene-candidate-v1") return;
      if (typeof result.ok !== "boolean") { finish(new Error("候选编译消息格式无效")); return; }
      if (!result.ok) finish(new Error(result.error ?? "候选编译失败"));
      else if (typeof result.packageJson !== "string" || !result.evidence || !result.report) finish(new Error("候选编译消息缺少结果"));
      else if (hash(Buffer.from(result.packageJson)) !== result.evidence.targetArtifactHash) finish(new Error("候选编译产物 hash 不匹配"));
      else finish(undefined, { packageJson: result.packageJson, evidence: result.evidence, report: result.report, compilerSha256 });
    });
  });
}
