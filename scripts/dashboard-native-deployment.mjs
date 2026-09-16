import { parseDeepRuntimePackage, runtimeContentSha256 } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { createDashboardContentCompiler } from "./dashboard-content-compiler.mjs";
import { createNativeWindowVerifier } from "./lib/nativeWindowVerifier.mjs";
import { createDashboardNativeWindowVerifier } from "./lib/dashboardNativeWindowVerifier.mjs";

/** Startup-owned compiler and real native process verifier, bundled together. */
export async function createDashboardNativeDeployment({ nativeExecutable, configuration }) {
  const compiler = await createDashboardContentCompiler({ nativeExecutable, configuration });
  const verify = createDashboardNativeWindowVerifier({ nativeExecutable, parseDeepRuntimePackage,
    runtimeContentSha256, verifyNativeWindow: createNativeWindowVerifier(parseDeepRuntimePackage) });
  return { compiler, verifier: { verify } };
}
