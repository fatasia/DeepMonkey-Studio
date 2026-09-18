import { createReadStream } from "node:fs";
import { sceneClientArchiveLimits, verifySceneClientArchive } from "./lib/sceneClientArchive.mjs";

try {
  const [path, targetFlag, expectedTarget, ...rest] = process.argv.slice(2);
  if (!path || targetFlag !== "--target" || !["three-webview", "deep-native"].includes(expectedTarget) || rest.length) {
    throw new Error("用法：node scripts/verify-scene-client-package.mjs <包.bimscene.zip> --target <three-webview|deep-native>");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > sceneClientArchiveLimits.archiveBytes) throw new Error("客户端 ZIP 超过 512 MiB 读取限额");
    chunks.push(chunk);
  }
  const result = await verifySceneClientArchive(Buffer.concat(chunks, bytes), { expectedTarget });
  console.log(JSON.stringify({ status: "integrity-verified", target: result.manifest.target,
    contentHash: result.manifest.contentHash.value, fileCount: result.fileCount, totalBytes: result.totalBytes }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
