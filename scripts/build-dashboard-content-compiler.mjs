import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const { build } = createRequire(path.join(root, "apps/api/package.json"))("esbuild");
const [flag, output, ...rest] = process.argv.slice(2);
if (flag !== undefined && (flag !== "--output" || !output || rest.length)) throw new Error("Expected --output <build directory>");
const directory = output ? path.resolve(output) : path.join(root, "apps/api/dist/dashboard-content-compiler");
await mkdir(directory, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["scripts/dashboard-content-compiler.mjs"],
  outfile: path.join(directory, "compiler.mjs"), bundle: true, platform: "node", format: "esm",
  conditions: ["development"], external: ["sharp"], logLevel: "error" });
console.log("Dashboard content compiler built");
