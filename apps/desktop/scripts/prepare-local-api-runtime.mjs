import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLocalPublicationRuntime } from "../../api/scripts/prepare-local-publication-runtime.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(desktopRoot, "local-api-bundle");
const pnpm = process.platform === "win32"
  ? { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "pnpm.CMD"] }
  : { command: "pnpm", prefix: [] };

rmSync(output, { recursive: true, force: true });
// `pnpm deploy` only copies the current dist directory. Build first so a
// clean checkout cannot package stale or missing API code.
runPnpm(["--filter", "@bim-studio/api", "build"]);
// pnpm 11 legacy deploy mutates the source workspace's node_modules into a
// production-only install. Injected workspace deployment keeps the source
// install intact and produces a self-contained runtime directory.
// Tauri's resource copier intentionally skips Windows junctions. A pnpm
// isolated deploy therefore ships `.pnpm` but omits the package aliases that
// Node resolves from `node_modules`. Hoisted deployment materializes physical
// package directories so the installed sidecar remains executable.
runPnpm([
  "--config.inject-workspace-packages=true",
  "--config.node-linker=hoisted",
  "--filter", "@bim-studio/api",
  "deploy", "--prod", output,
]);

// The deployed graph includes package source maps and TypeScript sources even
// though the sidecar executes only built JavaScript. Some OPC UA filenames put
// those non-runtime files beyond the path length accepted by NSIS on Windows.
// Prune only development artifacts; package metadata, JavaScript, data files
// and native add-ons remain untouched.
const prunedDevelopmentArtifacts = pruneDevelopmentArtifacts(path.join(output, "node_modules"));
for (const relativePath of ["src", "test-output", "tsconfig.json", "vitest.config.ts", "pnpm-workspace.yaml"]) {
  rmSync(path.join(output, relativePath), { recursive: true, force: true });
}
console.log(`Tauri local API: pruned ${prunedDevelopmentArtifacts} non-runtime source artifacts`);

await prepareLocalPublicationRuntime({ outputRoot: output });

copyFileSync(process.execPath, path.join(output, process.platform === "win32" ? "node.exe" : "node"));
for (const required of ["dist/index.js", "publication-runtime.json", "publication/native/deep-engine-native.exe",
  "publication/android/deep-scene-viewer-template.apk", "publication/android/jre/bin/java.exe",
  process.platform === "win32" ? "node.exe" : "node"]) {
  if (!existsSync(path.join(output, required))) throw new Error(`本地 API 运行包缺少 ${required}`);
}
console.log(`Tauri 本地 API 运行包：${output}`);

function runPnpm(args) {
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function pruneDevelopmentArtifacts(root) {
  let removed = 0;
  const pending = [root];
  const developmentDirectories = new Set(["test", "tests", "__tests__", "fixture", "fixtures"]);
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (developmentDirectories.has(entry.name.toLowerCase())) {
          rmSync(candidate, { recursive: true, force: true });
          removed += 1;
          continue;
        }
        pending.push(candidate);
        continue;
      }
      if (!isDevelopmentArtifact(entry.name)) continue;
      rmSync(candidate, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function isDevelopmentArtifact(name) {
  return name.endsWith(".map")
    || name.endsWith(".d.ts")
    || name.endsWith(".d.cts")
    || name.endsWith(".d.mts")
    || name.endsWith(".ts")
    || name.endsWith(".tsx");
}
