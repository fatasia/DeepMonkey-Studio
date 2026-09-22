import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PublicationCapabilityEvidence, SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import type { NativeSceneWindowEvidence } from "./nativeSceneWindowVerifier.js";
import { prepareNativeSceneCandidate } from "./prepareNativeSceneCandidate.js";
import { assessVerifiedNativeSceneCandidate } from "./nativeSceneCandidateCompiler.js";
import { createNativeSceneCandidateRegistry } from "./nativeSceneCandidateRegistry.js";
import { storePublicationResourceBytes } from "./publicationResourceSnapshot.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";

interface Dependencies {
  store: MetadataStore; objects: ObjectStore; dataDir: string;
  nativeExecutable?:string;
  verifyWindow: (packagePath: string, signal?: AbortSignal) => Promise<NativeSceneWindowEvidence>;
  prepare?: typeof prepareNativeSceneCandidate;
  assess?: typeof assessVerifiedNativeSceneCandidate;
}

/** 显式请求才运行窗口；一次服务只验证一个候选，成功后返回短期不透明 ID。 */
export function createNativeSceneCandidateService(dependencies: Dependencies) {
  const registry = createNativeSceneCandidateRegistry();
  let running = false;
  return {
    reserve: registry.reserve,
    async prepare(actorId: string, expectedScene: SceneSnapshot, signal?: AbortSignal) {
      if (!actorId) throw new Error("Native 验证需要登录用户");
      if (running) throw new Error("已有 Native 窗口验证正在运行，请稍后重试");
      running = true;
      let directory: string | undefined;
      try {
        const scene = structuredClone(expectedScene);
        const expectedPublication = structuredClone(dependencies.store.getPublication(scene.id));
        signal?.throwIfAborted();
        const candidate = await (dependencies.prepare ?? prepareNativeSceneCandidate)({ ...dependencies, scene,
          ...(signal ? { signal } : {}) });
        const { compiled, capture } = candidate;
        // Uncompiled entries describe optional capabilities that the Native
        // package may omit.  They remain visible in the report so consumers
        // can hide their controls, while core evidence is still checked below
        // and a corrupted/blocked report cannot reach publication.
        if (Buffer.byteLength(compiled.packageJson) > 256 * 1024 ** 2) throw new Error("Native 编译产物超过 256MiB");
        const content = Buffer.from(compiled.packageJson), artifactHash = createHash("sha256").update(content).digest("hex");
        if (artifactHash !== compiled.evidence.targetArtifactHash) throw new Error("Native 编译产物身份不一致");
        directory = await mkdtemp(path.join(tmpdir(), "native-publication-candidate-"));
        const file = path.join(directory, "runtime-package.json");
        await writeFile(file, content, { flag: "wx", mode: 0o400 });
        const verified = await dependencies.verifyWindow(file, signal);
        signal?.throwIfAborted();
        if (verified.sourceSha256 !== artifactHash || verified.scope !== "native-window"
          || verified.report.gpuErrorsClean !== true) throw new Error("Native 窗口证据不属于当前编译产物");
        const capabilities = [...new Set(compiled.report.items.map(item => item.capability))];
        const runtimeEvidence: PublicationCapabilityEvidence[] = capabilities.map(capability => ({
          id: `${verified.nonce}:${capability}`, capability, target: "deep-native", scope: "native-window",
          sourceSemanticHash: compiled.report.contentFingerprint, compileGraphHash: compiled.report.compileGraphHash,
          targetArtifactHash: artifactHash, fixtureId: compiled.report.fixtureId, platform: "windows-x64",
        }));
        const report = await (dependencies.assess ?? assessVerifiedNativeSceneCandidate)({ scene, compiled, runtimeEvidence,
          ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (report.status === "blocked") return { status: "blocked" as const, report };
        const assertCurrent = () => {
          const project = dependencies.store.getProject(scene.projectId);
          if (!project || !scenePublicationJsonEqual(dependencies.store.getScene(scene.projectId, scene.id), scene)
            || !scenePublicationJsonEqual(expectedPublication, dependencies.store.getPublication(scene.id))
            || !scenePublicationJsonEqual(capture.inputs, selectSceneClientDependencyInputs(project, scene,
              dependencies.store.listApplications(scene.projectId)))) throw new Error("场景、发布或依赖在窗口验证期间已变化，请重新验证");
        };
        assertCurrent();
        const resource = await storePublicationResourceBytes({ ...dependencies, projectId: scene.projectId,
          expected: { bytes: content.length, sha256: artifactHash }, ...(signal ? { signal } : {}) }, content);
        signal?.throwIfAborted();
        assertCurrent();
        const registered = registry.register({ actorId, scene, ...(expectedPublication ? { expectedPublication } : {}),
          capture: { ...capture, nativeCompiled: { runtimePackage: resource, compilationEvidence: compiled.evidence,
            compatibilityReport: report, compilerSha256: compiled.compilerSha256,
            executableSha256: verified.executableSha256, verifiedAt: verified.verifiedAt } } });
        return { status: "ready" as const, ...registered, report };
      } finally {
        try { if (directory) await rm(directory, { recursive: true, force: true }); }
        finally { running = false; }
      }
    },
  };
}
