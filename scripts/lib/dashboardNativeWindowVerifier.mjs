import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bindDashboardWindowEvidence } from "./dashboardWindowEvidence.mjs";

/**
 * The injected verifier is the dashboard-chain native-window process boundary
 * (`--verify-dashboard-package`); scene `--verify-package` must never be fed a
 * dashboard candidate. An artifact without a dashboard entrypoint fails closed
 * here instead of reaching the native process.
 */
export function createDashboardNativeWindowVerifier({ nativeExecutable, parseDeepRuntimePackage,
  runtimeContentSha256, verifyNativeWindow }) {
  return async (input, signal) => {
    signal?.throwIfAborted();
    const snapshot = structuredClone(input);
    const parsed = parseDeepRuntimePackage(snapshot.artifact);
    if (!parsed.valid || parsed.value.schemaVersion !== 5) throw new Error("Dashboard verifier requires a valid v5 artifact");
    if (!parsed.value.entrypoints?.dashboard) throw new Error("Dashboard verifier requires a dashboard entrypoint");
    const directory = await mkdtemp(path.join(tmpdir(), "dashboard-window-"));
    try {
      const packagePath = path.join(directory, "runtime-package.json");
      await writeFile(packagePath, snapshot.artifact, { flag: "wx", mode: 0o400 });
      signal?.throwIfAborted();
      const receipt = await verifyNativeWindow({ packagePath, nativeExecutable, frames: 3, signal });
      signal?.throwIfAborted();
      return bindDashboardWindowEvidence(snapshot, parsed.value, receipt, runtimeContentSha256);
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
}
