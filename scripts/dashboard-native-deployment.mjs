import { parseDeepRuntimePackage, runtimeContentSha256 } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { createDashboardContentCompiler } from "./dashboard-content-compiler.mjs";
import { createDashboardNativeProcessVerifier } from "./lib/nativeWindowVerifier.mjs";
import { createDashboardNativeWindowVerifier } from "./lib/dashboardNativeWindowVerifier.mjs";

/**
 * Startup-owned compiler and real native process verifier, bundled together.
 * Dashboard candidates verify through the dashboard-chain command
 * (`--verify-dashboard-package`); the scene `--verify-package` command rejects
 * dashboard content by design (native fail-closed since 8a9f15a9).
 */
export async function createDashboardNativeDeployment({ nativeExecutable, configuration }) {
  const compiler = await createDashboardContentCompiler({ nativeExecutable, configuration });
  const verify = createDashboardNativeWindowVerifier({ nativeExecutable, parseDeepRuntimePackage,
    runtimeContentSha256, verifyNativeWindow: createDashboardNativeProcessVerifier(parseDeepRuntimePackage) });
  return { compiler, verifier: { verify } };
}
