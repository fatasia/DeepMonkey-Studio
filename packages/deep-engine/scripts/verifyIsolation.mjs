import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "dist/lab/manifest.json"), "utf8"));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (Object.keys(metadata.dependencies ?? {}).length) throw new Error("Experimental runtime must not silently acquire engine dependencies.");
const buildInputs = [
  { inputs: manifest.inputs, allowedDependencies: [] },
  { inputs: manifest.migrationSwitchLab?.inputs,
    allowedDependencies: manifest.migrationSwitchLab?.runtimeEngineDependencies },
  { inputs: manifest.competitiveBenchmarkLab?.inputs,
    allowedDependencies: manifest.competitiveBenchmarkLab?.runtimeEngineDependencies },
];
for (const { inputs, allowedDependencies } of buildInputs) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("Every Lab entry must publish its complete build input manifest.");
  }
  if (!Array.isArray(allowedDependencies)
    || allowedDependencies.some((name) => typeof name !== "string" || name !== "three")) {
    throw new Error("Lab dependency allowlists may contain only the explicit Three comparison boundary.");
  }
  for (const input of Object.keys(inputs)) {
    const normalized = input.replaceAll("\\", "/");
    const local = /^(src|lab)\//.test(normalized);
    const allowedThree = allowedDependencies.includes("three")
      && /(^|\/)node_modules\/(?:\.pnpm\/three@[^/]+\/node_modules\/)?three\//.test(normalized);
    if (!local && !allowedThree) {
      throw new Error(`Runtime build escaped the independent package: ${input}`);
    }
  }
}
try {
  const rawHits = execFileSync("rg", ["-n", "--glob", "*.{ts,tsx,js,mjs,json}", "@bim-studio/deep-engine|packages/deep-engine", "apps"], { cwd: path.resolve(root, "../.."), encoding: "utf8" });
  const hits = rawHits.split(/\r?\n/).filter((line) => !/^apps\\web\\src\\viewer[\\/]/.test(line) && !/^apps\\web\\package\.json:/.test(line)).join("\n");
  if (!hits) throw { status: 1 };
  throw new Error(`Production apps reference the experimental engine:\n${hits}`);
} catch (error) {
  if (error.status !== 1) throw error;
}
console.log("Isolation passed: Deep runtime has local inputs only; Three is confined to declared comparison entries; no production app references.");
