import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createDashboardPortableZip } from "../apps/api/src/dashboardPortableZip.js";

const usage = "pnpm exec tsx --conditions=development scripts/package-dashboard-portable.mts <archive.dmda> --native-executable <player.exe> --output <dashboard.zip>";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(usage);
  else {
    const [archive, nativeFlag, executable, outputFlag, output] = args;
    if (args.length !== 5 || !archive || nativeFlag !== "--native-executable" || !executable || outputFlag !== "--output" || !output) throw new Error(usage);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of createReadStream(archive)) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 512 * 1024 ** 2) throw new Error("Dashboard archive exceeds 512 MiB");
      chunks.push(bytes);
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Dashboard packaging interrupted"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const zip = await createDashboardPortableZip(Buffer.concat(chunks, size), path.resolve(executable), { signal: controller.signal });
      controller.signal.throwIfAborted();
      await writeFile(path.resolve(output), zip, { flag: "wx" });
      console.log(path.resolve(output));
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
} catch (reason) {
  console.error(reason instanceof Error ? reason.message : String(reason));
  process.exitCode = 1;
}
