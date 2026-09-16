import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import type { AuthoritativeDashboardCompiler } from "./dashboardPublicationCapability.js";
import type { DashboardNativeWindowVerifier } from "./dashboardNativeCandidateRuntime.js";
import { createDashboardPublishedClosure } from "./dashboardPublishedClosure.js";
import { createDashboardPublishedFontCatalog, type DashboardPublishedFontConfiguration } from "./dashboardPublishedFontCatalog.js";
import { registerDashboardNativeCandidateRouteRuntime } from "./dashboardNativeCandidateRouteRuntime.js";

interface DashboardDeploymentConfig {
  readonly nativeExecutable: string;
  readonly expectedDeviceFingerprintSha256: string;
  readonly configuration: Record<string, unknown> & { locale: string; packageVersion: string };
  readonly fontCatalog?: DashboardPublishedFontConfiguration;
}

/** Only the server startup environment selects this file; HTTP cannot select executable code. */
export async function registerConfiguredDashboardNative(app: FastifyInstance, dependencies: {
  store: MetadataStore; objects: ObjectStore; config: AppConfig;
}, deploymentFile = process.env.DASHBOARD_NATIVE_DEPLOYMENT_FILE) {
  if (!deploymentFile) return;
  const deployment = await readDashboardDeploymentConfig(deploymentFile);
  const fonts = deployment.fontCatalog ? createDashboardPublishedFontCatalog(deployment.fontCatalog, dependencies.objects) : undefined;
  const bundleUrl = new URL("../dist/dashboard-content-compiler/deployment.mjs", import.meta.url);
  const bundle = await import(bundleUrl.href) as {
    createDashboardNativeDeployment(input: Pick<DashboardDeploymentConfig, "nativeExecutable" | "configuration">): Promise<{
      compiler: AuthoritativeDashboardCompiler; verifier: DashboardNativeWindowVerifier;
    }>;
  };
  const bindings = await bundle.createDashboardNativeDeployment({ nativeExecutable: deployment.nativeExecutable,
    configuration: { ...deployment.configuration, ...(fonts ? { nodeAssets: fonts.compilerNodeAssets } : {}) } });
  return registerDashboardNativeCandidateRouteRuntime(app, {
    runtime: { store: dependencies.store, objects: dependencies.objects,
      closure: createDashboardPublishedClosure(dependencies.store, dependencies.config, fonts ? { fonts } : {}),
      compiler: bindings.compiler, verifier: bindings.verifier,
      expectedDeviceFingerprintSha256: deployment.expectedDeviceFingerprintSha256 },
    nativeExecutable: deployment.nativeExecutable,
  });
}

export async function readDashboardDeploymentConfig(file: string): Promise<DashboardDeploymentConfig> {
  if (!path.isAbsolute(file)) throw new Error("Dashboard deployment configuration must use an absolute path");
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Dashboard deployment configuration exceeds 1 MiB");
  const value = JSON.parse(await readFile(file, "utf8")) as DashboardDeploymentConfig;
  if (!value || typeof value !== "object" || typeof value.nativeExecutable !== "string"
    || !path.isAbsolute(value.nativeExecutable) || path.extname(value.nativeExecutable).toLowerCase() !== ".exe"
    || typeof value.expectedDeviceFingerprintSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.expectedDeviceFingerprintSha256)
    || !value.configuration || typeof value.configuration !== "object" || Array.isArray(value.configuration)
    || typeof value.configuration.locale !== "string" || !value.configuration.locale.trim()
    || typeof value.configuration.packageVersion !== "string" || !value.configuration.packageVersion.trim()) {
    throw new Error("Dashboard deployment requires a Windows player, device fingerprint, locale and package version");
  }
  return value;
}
