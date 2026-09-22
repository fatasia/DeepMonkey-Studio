import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import type { AuthoritativeDashboardCompiler } from "./dashboardPublicationCapability.js";
import type { DashboardNativeWindowVerifier } from "./dashboardNativeCandidateRuntime.js";
import { createDashboardLayoutCaptureDeployment } from "./dashboardLayoutCaptureDeployment.js";
import { createDashboardPublishedClosure } from "./dashboardPublishedClosure.js";
import { createDashboardPublishedFontCatalog, type DashboardPublishedFontConfiguration } from "./dashboardPublishedFontCatalog.js";
import { registerDashboardNativeCandidateRouteRuntime } from "./dashboardNativeCandidateRouteRuntime.js";
import { createDashboardWebStaticDeployment, isDashboardWebStaticDeploymentConfig,
  type DashboardWebStaticDeploymentConfig } from "./dashboardWebStaticDeployment.js";

interface DashboardDeploymentConfig {
  readonly nativeExecutable: string;
  readonly expectedDeviceFingerprintSha256: string;
  readonly configuration: Record<string, unknown> & { locale: string; packageVersion: string };
  readonly fontCatalog?: DashboardPublishedFontConfiguration;
  /**
   * G04:可选布局测量宿主配置。给出时编译输入为测量组件绑定服务端布局;
   * 缺省时行为与未接线部署一致(编译输入保持纯冻结数据)。
   */
  readonly layoutCapture?: { readonly chromePath: string; readonly capturePageDirectory?: string };
  readonly webStatic?: DashboardWebStaticDeploymentConfig;
}

/** Only the server startup environment selects this file; HTTP cannot select executable code. */
export async function registerConfiguredDashboardNative(app: FastifyInstance, dependencies: {
  store: MetadataStore; objects: ObjectStore; config: AppConfig;
}, deploymentFile = process.env.DASHBOARD_NATIVE_DEPLOYMENT_FILE) {
  if (!deploymentFile) return;
  const deployment = await readDashboardDeploymentConfig(deploymentFile);
  const webStatic = deployment.webStatic
    ? await createDashboardWebStaticDeployment(deployment.webStatic, dependencies.store, dependencies.objects) : undefined;
  const fonts = deployment.fontCatalog ? createDashboardPublishedFontCatalog(deployment.fontCatalog, dependencies.objects) : undefined;
  const bundleUrl = new URL("../dist/dashboard-content-compiler/deployment.mjs", import.meta.url);
  const bundle = await import(bundleUrl.href) as {
    createDashboardNativeDeployment(input: Pick<DashboardDeploymentConfig, "nativeExecutable" | "configuration">): Promise<{
      compiler: AuthoritativeDashboardCompiler; verifier: DashboardNativeWindowVerifier;
    }>;
  };
  const bindings = await bundle.createDashboardNativeDeployment({ nativeExecutable: deployment.nativeExecutable,
    configuration: { ...deployment.configuration, ...(fonts ? { nodeAssets: fonts.compilerNodeAssets } : {}) } });
  const nativeExecutableSha256 = bindings.compiler.configuration.nativeSha256;
  if (typeof nativeExecutableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(nativeExecutableSha256)) {
    throw new Error("Dashboard compiler must bind the deployed Native executable SHA-256");
  }
  // 装配期快速失败:Chrome 可执行文件、捕获页产物与端口绑定在此校验,不拖到首次捕获。
  const layoutCapture = deployment.layoutCapture ? await createDashboardLayoutCaptureDeployment({
    chromePath: deployment.layoutCapture.chromePath,
    capturePageDirectory: deployment.layoutCapture.capturePageDirectory
      ?? fileURLToPath(new URL("../dist/dashboard-content-compiler/", import.meta.url)),
  }) : undefined;
  if (layoutCapture) app.addHook("onClose", async () => { await layoutCapture.close(); });
  try {
    return await registerDashboardNativeCandidateRouteRuntime(app, {
      runtime: { store: dependencies.store, objects: dependencies.objects,
        closure: createDashboardPublishedClosure(dependencies.store, dependencies.config, fonts ? { fonts } : {}),
        compiler: bindings.compiler, verifier: bindings.verifier,
        expectedDeviceFingerprintSha256: deployment.expectedDeviceFingerprintSha256,
        ...(layoutCapture ? { layoutCapture: { host: layoutCapture.host, locale: layoutCapture.locale } } : {}) },
      nativeExecutable: deployment.nativeExecutable,
      nativeExecutableSha256,
      ...(webStatic ? { webStatic } : {}),
    });
  } catch (error) {
    // 路由注册失败时启动整体失败,托管的捕获页服务不能悬空到进程退出。
    await layoutCapture?.close();
    throw error;
  }
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
    || typeof value.configuration.packageVersion !== "string" || !value.configuration.packageVersion.trim()
    || !isValidLayoutCaptureConfig(value.layoutCapture)
    || (value.webStatic !== undefined && !isDashboardWebStaticDeploymentConfig(value.webStatic))) {
    throw new Error("Dashboard deployment requires a Windows player, device fingerprint, locale and package version");
  }
  return value;
}

function isValidLayoutCaptureConfig(value: DashboardDeploymentConfig["layoutCapture"]): boolean {
  if (value === undefined) return true;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.chromePath === "string" && path.isAbsolute(value.chromePath)
    && (value.capturePageDirectory === undefined
      || typeof value.capturePageDirectory === "string" && path.isAbsolute(value.capturePageDirectory));
}
