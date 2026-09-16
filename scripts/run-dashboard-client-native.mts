import { createReadStream } from "node:fs";
import path from "node:path";
import { runDashboardOfflineNative } from "../apps/api/src/dashboardOfflineNativeProcess.js";

const usage = "pnpm exec tsx --conditions=development scripts/run-dashboard-client-native.mts <archive.dmda> --native-executable <player.exe>";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else {
    const [archivePath, flag, executable] = args;
    if (args.length !== 3 || !archivePath || flag !== "--native-executable" || !executable) throw new Error(usage);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of createReadStream(archivePath)) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 512 * 1024 ** 2) throw new Error("Dashboard archive exceeds 512 MiB");
      chunks.push(bytes);
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Dashboard playback interrupted"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      await runDashboardOfflineNative(Buffer.concat(chunks, size), path.resolve(executable), { signal: controller.signal });
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
} catch (reason) {
  console.error(reason instanceof Error ? reason.message : String(reason));
  process.exitCode = 1;
}
