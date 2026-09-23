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
import { registerDashboardOfflineArchiveDownloadRoutes,
  type DashboardWebStaticDownloadDependencies } from "./dashboardOfflineArchiveDownloadRoutes.js";
import type { DashboardAndroidApkDependencies } from "./dashboardAndroidApk.js";
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
  /** 部署固定的 Windows 播放器路径；省略时仅提供 DMDA 下载。 */
  readonly nativeExecutable?: string;
  readonly nativeExecutableSha256?: string;
  /** Web 静态包下载的部署侧供给；省略时不注册 web-package 下载。 */
  readonly webStatic?: DashboardWebStaticDownloadDependencies;
  /** 场景安卓发布:模板 APK + build-tools + 部署默认签名;省略时不注册 android-apk 下载。 */
  readonly androidApk?: DashboardAndroidApkDependencies;
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
  await registerDashboardPublicationCandidateRoutes(app, runtime.service, registry,
    [...(dependencies.nativeExecutable ? ["exe", "zip"] as const : []),
      ...(dependencies.webStatic ? ["web"] as const : []),
      ...(dependencies.androidApk ? ["apk"] as const : []), "dmda"]);
  await registerDashboardOfflineArchiveDownloadRoutes(app, {
    registry,
    ...(dependencies.nativeExecutable === undefined ? {} : { portable: { nativeExecutable: dependencies.nativeExecutable,
      ...(dependencies.nativeExecutableSha256 === undefined ? {} : { expectedSha256: dependencies.nativeExecutableSha256 }) } }),
    ...(dependencies.webStatic === undefined ? {} : { webStatic: dependencies.webStatic }),
    ...(dependencies.androidApk === undefined ? {} : { android: dependencies.androidApk }),
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
