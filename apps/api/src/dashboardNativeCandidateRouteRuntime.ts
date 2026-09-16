import type { FastifyInstance } from "fastify";
import {
  createDashboardNativeCandidateRegistry,
  type DashboardNativeCandidateRegistry,
  type DashboardNativeCandidateRegistryOptions,
} from "./dashboardNativeCandidateRegistry.js";
import {
  createDashboardNativeCandidateRuntime,
  type DashboardNativeCandidateRuntime,
  type DashboardNativeCandidateRuntimeDependencies,
} from "./dashboardNativeCandidateRuntime.js";
import { registerDashboardOfflineArchiveDownloadRoutes } from "./dashboardOfflineArchiveDownloadRoutes.js";
import { registerDashboardPublicationCandidateRoutes } from "./dashboardPublicationCandidateRoutes.js";

export interface DashboardNativeCandidateRouteRuntimeDependencies {
  /**
   * Deployment-owned implementations of publication closure resolution,
   * authoritative native compilation, and native-window verification.
   * This module deliberately cannot synthesize any of them from HTTP/config.
   */
  readonly runtime: DashboardNativeCandidateRuntimeDependencies;
  readonly registry?: DashboardNativeCandidateRegistry;
  readonly registryOptions?: DashboardNativeCandidateRegistryOptions;
}

export interface DashboardNativeCandidateRouteRuntime {
  readonly runtime: DashboardNativeCandidateRuntime;
  readonly registry: DashboardNativeCandidateRegistry;
}

/**
 * Registers C5 only after the host gives us the genuine C3/C4 authority
 * sources. Keeping this explicit prevents index.ts from advertising a route
 * that accepts work without an authoritative compiler or verifier behind it.
 */
export async function registerDashboardNativeCandidateRouteRuntime(
  app: FastifyInstance,
  dependencies: DashboardNativeCandidateRouteRuntimeDependencies,
): Promise<DashboardNativeCandidateRouteRuntime> {
  const runtime = createDashboardNativeCandidateRuntime(dependencies.runtime);
  const registry = dependencies.registry ?? createDashboardNativeCandidateRegistry(dependencies.registryOptions);
  await registerDashboardPublicationCandidateRoutes(app, runtime.service, registry);
  await registerDashboardOfflineArchiveDownloadRoutes(app, {
    registry,
    readFreezeManifest: async ({ record, signal }) => {
      signal?.throwIfAborted();
      const manifest = record.candidate.freezeManifest;
      if (manifest.manifestSha256 !== record.candidate.freezeManifestSha256
        || manifest.manifestSha256 !== record.summary.freezeManifestSha256) return undefined;
      return structuredClone(manifest);
    },
  });
  return Object.freeze({ runtime, registry });
}
