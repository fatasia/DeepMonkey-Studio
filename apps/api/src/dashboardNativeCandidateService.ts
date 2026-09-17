import {
  assertDashboardPublicationFreezeCommit,
  type DashboardPublicationFreezeCandidate,
  type DashboardPublicationFreezeManifest,
} from "./dashboardPublicationFreeze.js";
import type {
  DashboardPublicationAuthorityAdapter,
  DashboardPublicationAuthorityRequest,
} from "./dashboardPublicationAuthorityAdapter.js";
import {
  buildDashboardPublicationCapabilityReport,
  type AuthoritativeDashboardCompiler,
  type DashboardPublicationCapabilityReport,
  type DashboardWindowVerification,
} from "./dashboardPublicationCapability.js";
import {
  acceptDashboardRuntimeArtifactCompilerOutput,
  prepareDashboardRuntimeArtifactCompilerInput,
  type DashboardRuntimeArtifactCompilerInput,
  type DashboardRuntimeArtifactCompilerOutput,
  type VerifiedDashboardRuntimeArtifact,
} from "./dashboardRuntimeArtifactCompiler.js";
import { assertDashboardCandidatePublicationGate } from "./dashboardNativeCandidateRegistry.js";

/**
 * The only callable interface given to the isolated Native compiler worker.
 * It receives copied frozen bytes, not stores, a publication adapter, or a
 * visible dashboard surface.
 */
export interface DashboardNativeCandidateWorker {
  compile(input: DashboardRuntimeArtifactCompilerInput, signal?: AbortSignal): Promise<DashboardRuntimeArtifactCompilerOutput>;
}

export interface DashboardNativeCandidateServiceDependencies {
  readonly authority: DashboardPublicationAuthorityAdapter;
  readonly compiler: AuthoritativeDashboardCompiler;
  readonly compilerIdentity: DashboardRuntimeArtifactCompilerInput["compiler"];
  readonly expectedDeviceFingerprintSha256: string;
  readonly verifyWindow: (input: {
    readonly artifact: Uint8Array;
    readonly candidate: DashboardPublicationFreezeCandidate;
    readonly sourceSemanticHash: string;
    readonly compileGraphHash: string;
    readonly targetArtifactHash: string;
  }, signal?: AbortSignal) => Promise<DashboardWindowVerification>;
  readonly worker: DashboardNativeCandidateWorker;
}

/**
 * A fully checked runtime artifact. This record is deliberately data-only:
 * producing it cannot publish a WebGPU frame or persist an artifact.
 */
export interface DashboardNativeCandidate {
  readonly authority: DashboardPublicationFreezeCandidate["authority"];
  /** Server-only C3 snapshot retained so the download route can build DMDA bytes. */
  readonly freezeManifest: DashboardPublicationFreezeManifest;
  readonly freezeManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly artifactSha256: string;
  readonly windowVerification: DashboardWindowVerification;
  readonly capability: DashboardPublicationCapabilityReport;
  readonly artifact: VerifiedDashboardRuntimeArtifact;
}

export interface DashboardNativeCandidateService {
  readonly candidate: DashboardNativeCandidate | undefined;
  prepare(request: DashboardPublicationAuthorityRequest, signal?: AbortSignal): Promise<DashboardNativeCandidate>;
  clear(): void;
}

/**
 * C5's stateful candidate boundary. A new request cancels the preceding
 * request; every await is checked before a candidate becomes observable.
 * There is intentionally no publish, storage, route, scene, or renderer API.
 */
export function createDashboardNativeCandidateService(
  dependencies: DashboardNativeCandidateServiceDependencies,
): DashboardNativeCandidateService {
  let generation = 0;
  let pending: AbortController | undefined;
  let current: DashboardNativeCandidate | undefined;

  const requireCurrent = (value: number, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (generation !== value) throw new DashboardNativeCandidateSupersededError();
  };

  return {
    get candidate(): DashboardNativeCandidate | undefined { return current ? freezeCandidate(current) : undefined; },
    clear(): void {
      generation++;
      pending?.abort();
      pending = undefined;
      current = undefined;
    },
    async prepare(request: DashboardPublicationAuthorityRequest, outerSignal?: AbortSignal): Promise<DashboardNativeCandidate> {
      outerSignal?.throwIfAborted();
      generation++;
      const activeGeneration = generation;
      pending?.abort(new DashboardNativeCandidateSupersededError());
      const controller = new AbortController();
      pending = controller;
      const abort = () => controller.abort(outerSignal?.reason);
      outerSignal?.addEventListener("abort", abort, { once: true });
      try {
        requireCurrent(activeGeneration, controller.signal);
        const frozen = await dependencies.authority.prepare(request, controller.signal);
        const revalidation = dependencies.authority.revalidation(request);
        requireCurrent(activeGeneration, controller.signal);
        let receipt: DashboardWindowVerification | undefined;
        const capability = await buildDashboardPublicationCapabilityReport({ candidate: frozen,
          compiler: dependencies.compiler,
          expectedDeviceFingerprintSha256: dependencies.expectedDeviceFingerprintSha256,
          revalidation,
          verifyWindow: async (input, signal) => {
            const verified = await dependencies.verifyWindow(input, signal);
            receipt = clone(verified);
            return verified;
          },
          signal: controller.signal,
        });
        requireCurrent(activeGeneration, controller.signal);
        const compilerInput = await prepareDashboardRuntimeArtifactCompilerInput({ candidate: frozen,
          capability, compiler: dependencies.compilerIdentity, revalidation, signal: controller.signal });
        requireCurrent(activeGeneration, controller.signal);
        const output = await dependencies.worker.compile(compilerInput, controller.signal);
        requireCurrent(activeGeneration, controller.signal);
        const artifact = acceptDashboardRuntimeArtifactCompilerOutput(compilerInput, output, capability);
        await assertDashboardPublicationFreezeCommit(frozen, { ...revalidation, signal: controller.signal });
        requireCurrent(activeGeneration, controller.signal);
        if (!receipt) throw new Error("Dashboard window verifier returned no receipt");
        const result = freezeCandidate({ authority: frozen.authority,
          freezeManifest: frozen.manifest,
          freezeManifestSha256: frozen.manifest.manifestSha256,
          sourceSemanticHash: capability.sourceSemanticHash,
          compileGraphHash: capability.compileGraphHash,
          targetArtifactHash: capability.targetArtifactHash,
          artifactSha256: artifact.artifactSha256,
          windowVerification: receipt,
          capability,
          artifact,
        });
        assertDashboardCandidatePublicationGate(result);
        requireCurrent(activeGeneration, controller.signal);
        current = result;
        return freezeCandidate(result);
      } finally {
        outerSignal?.removeEventListener("abort", abort);
        if (pending === controller) pending = undefined;
      }
    },
  };
}

export class DashboardNativeCandidateSupersededError extends Error {
  override readonly name = "DashboardNativeCandidateSupersededError";
  constructor() { super("Dashboard Native candidate was superseded before it could become observable"); }
}

function freezeCandidate(value: DashboardNativeCandidate): DashboardNativeCandidate {
  return Object.freeze(clone(value));
}

function clone<T>(value: T): T { return structuredClone(value); }
