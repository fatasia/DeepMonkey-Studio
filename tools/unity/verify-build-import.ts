import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractUnityZip } from "../../apps/api/src/unityResourceRoutes.js";

async function main() {
  const archivePath = process.argv[2];
  if (!archivePath) throw new Error("Usage: pnpm exec tsx tools/unity/verify-build-import.ts <unity-build.zip>");

  const target = await mkdtemp(path.join(tmpdir(), "bim-unity-import-smoke-"));
  try {
    const result = await extractUnityZip(await readFile(path.resolve(archivePath)), target);
    const index = await readFile(path.join(target, result.playerPath), "utf8");
    await readFile(path.join(target, "unity-bridge.js"), "utf8");
    if (result.manifest.bridgeVersion !== 1) throw new Error("Unexpected Unity bridge version");
    if (!result.manifest.unityVersion) throw new Error("Unity version missing from imported manifest");
    if (!result.manifest.scenes?.includes("BridgeSmoke")) throw new Error("Smoke scene missing from imported manifest");
    if (!result.manifest.runtimeCapabilities?.includes("ack") || !result.manifest.runtimeCapabilities.includes("heartbeat"))
      throw new Error("Reliable runtime capabilities missing from imported manifest");
    if (!index.includes("unity-bridge.js") || !index.includes("BimStudioUnityBridge.register"))
      throw new Error("Imported player did not contain browser bridge registration");
    console.log(JSON.stringify({
      unityVersion: result.manifest.unityVersion,
      playerPath: result.playerPath,
      scenes: result.manifest.scenes,
      fileCount: result.fileCount,
      browserBridge: "registered",
      runtimeCapabilities: result.manifest.runtimeCapabilities
    }, null, 2));
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

void main();
