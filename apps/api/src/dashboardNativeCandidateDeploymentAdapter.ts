import type { AuthoritativeDashboardCompiler } from "./dashboardPublicationCapability.js";
import {
  createDashboardNativeCandidateRuntime,
  type DashboardNativeCandidateRuntime,
  type DashboardNativeCandidateRuntimeDependencies,
  type DashboardNativeWindowVerifier,
  type DashboardPublicationClosureReader,
} from "./dashboardNativeCandidateRuntime.js";
import type { DashboardNativeCandidateWorker } from "./dashboardNativeCandidateService.js";
import type { ObjectStore } from "./objects.js";

/**
 * Startup-owned bindings for the Dashboard native publication path.
 *
 * Application documents are authoritative publication records, but they do
 * not by themselves say how dashboard data bindings and resource revisions
 * are resolved. A deployment must supply that server-side resolver and the
 * native verifier explicitly; this adapter never derives either from HTTP or
 * a generic scene compiler configuration.
 */
export interface DashboardNativeCandidateDeploymentBindings {
  readonly closure?: DashboardPublicationClosureReader;
  readonly compiler?: AuthoritativeDashboardCompiler;
  readonly expectedDeviceFingerprintSha256?: string;
  readonly verifier?: DashboardNativeWindowVerifier;
  readonly worker?: DashboardNativeCandidateWorker;
}

export interface DashboardNativeCandidateDeploymentAdapterDependencies {
  readonly store: DashboardNativeCandidateRuntimeDependencies["store"];
  readonly objects: Pick<ObjectStore, "read">;
  readonly bindings: DashboardNativeCandidateDeploymentBindings;
}

export class DashboardNativeCandidateDeploymentUnavailableError extends Error {
  override readonly name = "DashboardNativeCandidateDeploymentUnavailableError";
}

/**
 * Turns real deployment bindings into the C5 runtime, or refuses startup
 * wiring before any candidate route can be exposed. This is deliberately a
 * narrow adapter: the generic C5 runtime stays testable while index.ts cannot
 * accidentally advertise Dashboard native delivery using Scene dependencies.
 */
export function createDashboardNativeCandidateDeploymentAdapter(
  dependencies: DashboardNativeCandidateDeploymentAdapterDependencies,
): DashboardNativeCandidateRuntime {
  const bindings = dependencies.bindings;
  assertBindings(bindings);
  return createDashboardNativeCandidateRuntime({
    store: dependencies.store,
    objects: dependencies.objects,
    closure: bindings.closure,
    compiler: bindings.compiler,
    expectedDeviceFingerprintSha256: bindings.expectedDeviceFingerprintSha256,
    verifier: bindings.verifier,
    ...(bindings.worker ? { worker: bindings.worker } : {}),
  });
}

function assertBindings(bindings: DashboardNativeCandidateDeploymentBindings): asserts bindings is {
  readonly closure: DashboardPublicationClosureReader;
  readonly compiler: AuthoritativeDashboardCompiler;
  readonly expectedDeviceFingerprintSha256: string;
  readonly verifier: DashboardNativeWindowVerifier;
  readonly worker?: DashboardNativeCandidateWorker;
} {
  if (!bindings.closure || typeof bindings.closure.derive !== "function"
    || typeof bindings.closure.resolveData !== "function" || typeof bindings.closure.resourceRevision !== "function") {
    throw unavailable("trusted Dashboard document/data/resource closure resolver");
  }
  const compiler = bindings.compiler;
  if (!compiler || typeof compiler.compile !== "function" || !validIdentifier(compiler.compilerId)
    || !validIdentifier(compiler.compilerVersion) || !sha256(compiler.compilerSha256)
    || !plainObject(compiler.configuration)) {
    throw unavailable("authoritative Dashboard compiler identity");
  }
  if (!sha256(bindings.expectedDeviceFingerprintSha256)) throw unavailable("native Dashboard verifier device identity");
  if (!bindings.verifier || typeof bindings.verifier.verify !== "function") throw unavailable("native Dashboard window verifier");
  if (bindings.worker && typeof bindings.worker.compile !== "function") throw unavailable("Dashboard compiler worker");
}

function unavailable(missing: string): DashboardNativeCandidateDeploymentUnavailableError {
  return new DashboardNativeCandidateDeploymentUnavailableError(`Dashboard Native candidate deployment is unavailable: missing ${missing}`);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
