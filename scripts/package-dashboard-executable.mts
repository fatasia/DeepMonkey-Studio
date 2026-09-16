import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createDashboardStandaloneExecutable } from "../apps/api/src/dashboardStandaloneExecutable.js";

const usage = "pnpm exec tsx --conditions=development scripts/package-dashboard-executable.mts <archive.dmda> --native-executable <player.exe> --output <dashboard.exe>";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    const [archive, nativeFlag, executable, outputFlag, output] = args;
    if (args.length !== 5 || !archive || nativeFlag !== "--native-executable" || !executable || outputFlag !== "--output" || !output || path.extname(output).toLowerCase() !== ".exe") throw new Error(usage);
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Dashboard packaging interrupted"));
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of createReadStream(archive, { signal: controller.signal })) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 512 * 1024 ** 2) throw new Error("Dashboard archive exceeds 512 MiB");
        chunks.push(bytes);
      }
      const bytes = await createDashboardStandaloneExecutable(Buffer.concat(chunks, size), path.resolve(executable), { signal: controller.signal });
      controller.signal.throwIfAborted();
      await writeFile(path.resolve(output), bytes, { flag: "wx" });
      console.log(path.resolve(output));
    } finally {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
  }
} catch (reason) {
  console.error(reason instanceof Error ? reason.message : String(reason)); process.exitCode = 1;
}
