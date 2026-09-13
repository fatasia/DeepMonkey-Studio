import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "dist/lab/manifest.json"), "utf8"));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (Object.keys(metadata.dependencies ?? {}).length) throw new Error("Experimental runtime must not silently acquire engine dependencies.");
for (const input of Object.keys(manifest.inputs)) {
  if (!/^(src|lab)\//.test(input.replaceAll("\\", "/"))) throw new Error(`Runtime build escaped the independent package: ${input}`);
}
try {
  const hits = execFileSync("rg", ["-n", "--glob", "*.{ts,tsx,js,mjs,json}", "@bim-studio/deep-engine|packages/deep-engine", "apps"], { cwd: path.resolve(root, "../.."), encoding: "utf8" });
  throw new Error(`Production apps reference the experimental engine:\n${hits}`);
} catch (error) {
  if (error.status !== 1) throw error;
}
console.log("Isolation passed: own src/lab inputs only; no runtime dependencies; no production app references.");
