import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installConsumer, isWithin, locatePnpm, packSdks, runLogged, sdkPackages } from "./lib/sdkConsumerPackages.mjs";
import { bundleConsumer, checkBrowser } from "./lib/sdkConsumerBrowser.mjs";

// Read existing dist only. The caller owns the dependency-ordered production build.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(join(tmpdir(), "bim-sdk-consumer-"));
assert.ok(!isWithin(root, workspace), "Consumer must be outside the monorepo");
const reportDir = join(root, "test-output/codex-2026-09-06", `sdk-consumer-${workspace.split(/[\\/]/).at(-1).replace("bim-sdk-consumer-", "")}`);
await mkdir(reportDir, { recursive: true });
console.log(`[sdk-consumer] external directory: ${workspace}\n[sdk-consumer] evidence: ${reportDir}`);
const report = { status: "running", workspace, reportDir, node: process.version, startedAt: new Date().toISOString() };

async function verifyTypes(consumer) {
  const require = createRequire(join(root, "package.json"));
  const tsc = resolve(dirname(require.resolve("typescript")), "../bin/tsc");
  const options = { cwd: consumer, reportDir };
  await runLogged(process.execPath, [tsc, "-p", "tsconfig.json", "--noEmit"], { ...options, label: "types-node-next" });
  await runLogged(process.execPath, [tsc, "-p", "tsconfig.browser.json"], { ...options, label: "types-browser-bundler" });
  const list = await runLogged(process.execPath, [tsc, "-p", "tsconfig.json", "--listFilesOnly"], { ...options, label: "type-resolution" });
  const sdkDeclarations = list.split(/\r?\n/).filter(path => /@bim-studio[\/\\](contracts|scene-sdk|server-sdk)[\/\\]/.test(path));
  assert.ok(sdkDeclarations.length >= 3);
  assert.ok(sdkDeclarations.every(path => isWithin(consumer, path) && /[/\\]dist[/\\].*\.d\.ts$/.test(path)), "Types must resolve from installed dist only");
  await runLogged(process.execPath, [tsc, "-p", "tsconfig.json"], { ...options, label: "emit-node-consumer" });
  const result = await runLogged(process.execPath, ["out/node/node.js"], { ...options, label: "runtime-node" });
  return { sdkDeclarations, result: JSON.parse(result.trim()), typescript: require("typescript").version };
}

async function verifyRuntimeResolution(consumer) {
  const names = sdkPackages.map(name => `@bim-studio/${name}`);
  const source = `console.log(JSON.stringify(${JSON.stringify(names)}.map(name => ({ name, resolved: import.meta.resolve(name) }))));`;
  const result = await runLogged(process.execPath, ["--input-type=module", "-e", source], { cwd: consumer, reportDir, label: "runtime-resolution" });
  const resolutions = JSON.parse(result);
  for (const item of resolutions) {
    const path = fileURLToPath(item.resolved);
    assert.ok(isWithin(consumer, path) && /[/\\]dist[/\\]index\.js$/.test(path), `Default export must be installed dist: ${item.name}`);
  }
  return resolutions;
}

try {
  const pnpm = await locatePnpm();
  const pnpmVersion = (await runLogged(process.execPath, [pnpm, "--version"], { cwd: root, reportDir, label: "pnpm-version" })).trim();
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(rootManifest.packageManager, `pnpm@${pnpmVersion}`, "Use the repository-pinned installed package manager");
  report.pnpm = pnpmVersion;
  report.packed = await packSdks({ root, workspace, reportDir, pnpm });
  const installed = await installConsumer({ root, workspace, reportDir, pnpm, packed: report.packed });
  report.install = installed;
  report.runtimeResolution = await verifyRuntimeResolution(installed.consumer);
  report.types = await verifyTypes(installed.consumer);
  const require = createRequire(join(root, "apps/web/package.json"));
  const viteRequire = createRequire(require.resolve("vite"));
  const esbuild = await import(pathToFileURL(viteRequire.resolve("esbuild")).href);
  report.bundle = await bundleConsumer({ consumer: installed.consumer, reportDir, esbuild });
  report.browser = await checkBrowser({ root, consumer: installed.consumer, reportDir, bundle: report.bundle, expected: report.types.result });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`[sdk-consumer] ${report.status}; temporary consumer retained for reproduction; no publish or production API calls`);
}
