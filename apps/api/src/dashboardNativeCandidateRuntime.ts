import type { PublishedApplicationRecord } from "@bim-studio/contracts";
import { createDashboardPublicationAuthorityAdapter, type DashboardPublicationAuthorityAdapter, type DashboardPublicationAuthorityRequest } from "./dashboardPublicationAuthorityAdapter.js";
import { createDashboardNativeCandidateService, type DashboardNativeCandidateService, type DashboardNativeCandidateServiceDependencies, type DashboardNativeCandidateWorker } from "./dashboardNativeCandidateService.js";
import type { AuthoritativeDashboardCompiler, DashboardWindowVerification } from "./dashboardPublicationCapability.js";
import type { DashboardFrozenResourceRequest, DashboardResolvedDataRequest, DashboardResolvedDataValue, DashboardResolvedResourceValue } from "./dashboardPublicationFreeze.js";
import type { DashboardRuntimeArtifactCompilerInput, DashboardRuntimeArtifactCompilerOutput } from "./dashboardRuntimeArtifactCompiler.js";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";

const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;

/**
 * Server-side source of the published dashboard's closure. Implementations
 * normally read binding/resource metadata from the application subsystem; the
 * HTTP request never reaches this interface.
 */
export interface DashboardPublicationClosureReader {
  derive(publication: PublishedApplicationRecord, entryPageId: string, signal?: AbortSignal): Promise<{
    readonly data: readonly DashboardResolvedDataRequest[];
    readonly resources: readonly DashboardFrozenResourceRequest[];
  }>;
  resolveData(authority: DashboardPublicationAuthorityRequest, request: DashboardResolvedDataRequest,
    signal?: AbortSignal): Promise<DashboardResolvedDataValue>;
  /** Reads current metadata, including the object revision, from a trusted source. */
  resourceRevision(authority: DashboardPublicationAuthorityRequest, request: DashboardFrozenResourceRequest,
    signal?: AbortSignal): Promise<number>;
}

/** A native verifier must attest the exact compiler artifact and frozen closure. */
export interface DashboardNativeWindowVerifier {
  verify(input: Parameters<DashboardNativeCandidateServiceDependencies["verifyWindow"]>[0], signal?: AbortSignal): Promise<DashboardWindowVerification>;
}

export interface DashboardNativeCandidateRuntimeDependencies {
  readonly store: Pick<MetadataStore, "getProject" | "getApplication" | "getApplicationPublicationPointer" | "getPublishedApplication">;
  readonly objects: Pick<ObjectStore, "read">;
  readonly closure: DashboardPublicationClosureReader;
  /** Deployment-owned compiler identity and implementation. */
  readonly compiler: AuthoritativeDashboardCompiler;
  /** Device identity of the native verifier host selected by the server. */
  readonly expectedDeviceFingerprintSha256: string;
  readonly verifier: DashboardNativeWindowVerifier;
  /** Defaults to the in-process compiler bridge; process workers may replace it. */
  readonly worker?: DashboardNativeCandidateWorker;
  /**
   * G04:装配层提供的可信布局宿主(deployment 组装,见 dashboardLayoutCaptureDeployment)。
   * 缺省时 service 行为与未接线部署一致。
   */
  readonly layoutCapture?: DashboardNativeCandidateServiceDependencies["layoutCapture"];
}

export interface DashboardNativeCandidateRuntime {
  readonly authority: DashboardPublicationAuthorityAdapter;
  readonly worker: DashboardNativeCandidateWorker;
  readonly service: DashboardNativeCandidateService;
}

/**
 * Composes C3--C5 with only trusted application metadata and object bytes.
 * It is intentionally the single dependency expected by the HTTP route
 * registration in index: route code receives only `service`.
 */
export function createDashboardNativeCandidateRuntime(
  dependencies: DashboardNativeCandidateRuntimeDependencies,
): DashboardNativeCandidateRuntime {
  const authority = createDashboardPublicationAuthorityAdapter({
    store: dependencies.store,
    trustedInputs: {
      derive: (publication, entryPageId, signal) => dependencies.closure.derive(publication, entryPageId, signal),
      resolveData: (request, item, signal) => dependencies.closure.resolveData(request, item, signal),
      readResource: async (authorityRequest, item, signal) => {
        signal?.throwIfAborted();
        const revision = await dependencies.closure.resourceRevision(authorityRequest, item, signal);
        signal?.throwIfAborted();
        return { revision, bytes: await readDashboardTrustedObject(dependencies.objects, item.objectKey, signal) };
      },
    },
  });
  const worker = dependencies.worker ?? createInProcessDashboardNativeCandidateWorker(dependencies.compiler);
  const compilerIdentity = Object.freeze({ id: dependencies.compiler.compilerId, version: dependencies.compiler.compilerVersion,
    sha256: dependencies.compiler.compilerSha256, configuration: structuredClone(dependencies.compiler.configuration) });
  const service = createDashboardNativeCandidateService({ authority, compiler: dependencies.compiler, compilerIdentity,
    expectedDeviceFingerprintSha256: dependencies.expectedDeviceFingerprintSha256,
    verifyWindow: (input, signal) => dependencies.verifier.verify(input, signal), worker,
    ...(dependencies.layoutCapture ? { layoutCapture: dependencies.layoutCapture } : {}) });
  return Object.freeze({ authority, worker, service });
}

/** A real bridge for deployments that run the authoritative compiler in this process. */
export function createInProcessDashboardNativeCandidateWorker(compiler: AuthoritativeDashboardCompiler): DashboardNativeCandidateWorker {
  return Object.freeze({
    async compile(input: DashboardRuntimeArtifactCompilerInput, signal?: AbortSignal): Promise<DashboardRuntimeArtifactCompilerOutput> {
      signal?.throwIfAborted();
      const result = await compiler.compile({ document: input.document, data: input.data, resources: input.resources,
        ...(input.freezeManifest ? { freezeManifest: input.freezeManifest } : {}) }, signal);
      signal?.throwIfAborted();
      return Object.freeze({ protocol: input.protocol, authority: structuredClone(input.authority),
        freezeManifestSha256: input.freezeManifestSha256, sourceSemanticHash: input.sourceSemanticHash,
        compileGraphHash: input.compileGraphHash, artifact: Uint8Array.from(result.artifact) });
    },
  });
}

export async function readDashboardTrustedObject(objects: Pick<ObjectStore, "read">, key: string, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const result = await objects.read(key);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => {
    result.stream.destroy();
    rejectAbort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const completed = result.completed.catch(reason => {
    result.stream.destroy();
    throw reason;
  });
  const pumping = (async () => {
    signal?.throwIfAborted();
    for await (const chunk of result.stream) {
      signal?.throwIfAborted();
      const bytes = chunk instanceof Uint8Array ? Uint8Array.from(chunk) : new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > MAX_RESOURCE_BYTES) throw new Error("Dashboard trusted object exceeds the frozen resource byte budget");
      chunks.push(bytes);
    }
  })();
  try {
    if (signal?.aborted) cancel();
    await Promise.race([Promise.all([completed, pumping]), cancelled]);
    signal?.throwIfAborted();
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  } finally {
    signal?.removeEventListener("abort", cancel);
    result.stream.destroy();
    await pumping.catch(() => undefined);
  }
}
