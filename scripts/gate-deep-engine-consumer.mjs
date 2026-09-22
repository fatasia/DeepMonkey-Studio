import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleConsumer } from "./lib/sdkConsumerBrowser.mjs";
import { checkDeepEngineBrowser } from "./lib/deepEngineConsumerBrowser.mjs";
import { installDeepEngineConsumer, packDeepEngineConsumerDependencies } from "./lib/deepEngineConsumerPackages.mjs";
import { isWithin, locatePnpm, runLogged } from "./lib/sdkConsumerPackages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(join(tmpdir(), "deep-engine-consumer-"));
assert.ok(!isWithin(root, workspace), "External consumer must be outside the monorepo");
const reportDir = join(root, "test-output/deep-engine-consumer-20260922"); await mkdir(reportDir, { recursive: true });
const report = { schema: 1, status: "running", workspace, reportDir, startedAt: new Date().toISOString(), node: process.version };
console.log(`[deep-engine-consumer] external directory: ${workspace}\n[deep-engine-consumer] evidence: ${reportDir}`);

async function verifyTypes(consumer) {
  const require = createRequire(join(root, "package.json"));
  const tsc = resolve(dirname(require.resolve("typescript")), "../bin/tsc"), options = { cwd: consumer, reportDir };
  await runLogged(process.execPath, [tsc, "-p", "tsconfig.json", "--noEmit"], { ...options, label: "types-node-next" });
  await runLogged(process.execPath, [tsc, "-p", "tsconfig.browser.json"], { ...options, label: "types-browser-bundler" });
  const list = await runLogged(process.execPath, [tsc, "-p", "tsconfig.browser.json", "--listFilesOnly"],
    { ...options, label: "type-resolution" });
  const declarations = list.split(/\r?\n/).filter(path => /(?:@bim-studio[\\/]deep-engine|@webgpu[\\/]types)[\\/]/.test(path));
  const normalized = declarations.map(path => path.replaceAll("\\", "/"));
  assert.ok(normalized.some(path => path.includes("/@bim-studio/deep-engine/dist/") && path.endsWith(".d.ts")));
  assert.ok(normalized.some(path => path.endsWith("/@webgpu/types/dist/index.d.ts")));
  assert.ok(declarations.every(path => isWithin(consumer, path) && !/[\\/]packages[\\/]deep-engine[\\/]src[\\/]/.test(path)),
    "External types must resolve only from isolated installed packages");
  await runLogged(process.execPath, [tsc, "-p", "tsconfig.json"], { ...options, label: "emit-node-consumer" });
  const output = await runLogged(process.execPath, ["out/node/node.js"], { ...options, label: "runtime-node" });
  return { declarations, nodeResult: JSON.parse(output.trim()), typescript: require("typescript").version };
}

async function verifyRuntimeResolution(consumer) {
  const specifiers = ["@bim-studio/deep-engine", "@bim-studio/deep-engine/app", "@bim-studio/deep-engine/webgpu"];
  const source = `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map(specifier=>({specifier,url:import.meta.resolve(specifier)}))));`;
  const output = await runLogged(process.execPath, ["--input-type=module", "-e", source],
    { cwd: consumer, reportDir, label: "runtime-resolution" });
  const resolutions = JSON.parse(output);
  for (const item of resolutions) {
    const path = fileURLToPath(item.url);
    assert.ok(isWithin(consumer, path) && /[\\/]dist[\\/].*\.js$/.test(path) && !/[\\/]src[\\/]/.test(path),
      `${item.specifier} did not resolve to installed dist`);
  }
  return resolutions;
}

try {
  const pnpm = await locatePnpm();
  report.pnpm = (await runLogged(process.execPath, [pnpm, "--version"], { cwd: root, reportDir, label: "pnpm-version" })).trim();
  report.packed = await packDeepEngineConsumerDependencies({ root, workspace, reportDir, pnpm });
  report.install = await installDeepEngineConsumer({ root, workspace, reportDir, pnpm, packed: report.packed });
  report.runtimeResolution = await verifyRuntimeResolution(report.install.consumer);
  report.types = await verifyTypes(report.install.consumer);
  const require = createRequire(join(root, "apps/web/package.json")), viteRequire = createRequire(require.resolve("vite"));
  const esbuild = await import(pathToFileURL(viteRequire.resolve("esbuild")).href);
  report.bundle = await bundleConsumer({ consumer: report.install.consumer, reportDir, esbuild });
  report.browser = await checkDeepEngineBrowser({ root, consumer: report.install.consumer, reportDir, bundle: report.bundle });
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`[deep-engine-consumer] ${report.status}; no package was published`);
}
