import { createDashboardOfflineNativeLaunchPlan } from "./dashboardOfflineNativeLauncher.js";
import { embedVerifiedNativeArtifact, type NativeExecutableOptions } from "./nativeStandaloneExecutable.js";

/** Dashboard retains its archive authority and semantic checks before shared packaging. */
export async function createDashboardStandaloneExecutable(archiveBytes: Uint8Array, nativeExecutable: string,
  options: NativeExecutableOptions = {}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const plan = createDashboardOfflineNativeLaunchPlan(archiveBytes);
  if (plan.artifact.byteLength > 256 * 1024 ** 2) throw new Error("Embedded Dashboard payload exceeds 256 MiB");
  return embedVerifiedNativeArtifact(plan.artifact, nativeExecutable, options);
}
