/**
 * H-C7-P2 运行门：8 个 3D 模板在仓外空项目 + 精确版本 SDK 安装下逐模板验收。
 *
 * 形态复用 scripts/gate-deep-engine-consumer.mjs 已验管线（不重建）：
 * pnpm pack → 离线安装仓外消费者 → tsc 双配置 → Node 无头断言 →
 * esbuild 自包含 bundler → Chrome WebGPU readback 像素证据 + 截图。
 *
 * 用法：pnpm gate:hc7p2-templates（根脚本先构建 deep-engine dist），
 * 或 node templates/deep-engine-3d/scripts/gate-templates.mjs。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runConsumerBrowser } from "../../../scripts/lib/sdkConsumerBrowser.mjs";
import { packDeepEngineCompression } from "../../../scripts/lib/deepEngineConsumerPackages.mjs";
import { isWithin, locatePnpm, runLogged } from "../../../scripts/lib/sdkConsumerPackages.mjs";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(kitRoot, "../..");
const cpuOnly = process.argv.includes("--cpu-only");
if (process.platform === "win32") {
  // 打包校验用 tar 需要解析 C:\ 盘符路径；Git Bash 的 GNU tar 会把 "C:" 当远程主机。
  // 与已通过的 deep-engine-consumer 门环境一致，优先使用 Windows 自带 bsdtar。
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  process.env.PATH = `${system32};${process.env.PATH ?? ""}`;
}
const reportDir = join(root, "test-output/hc7p2-templates-20261002");
await mkdir(reportDir, { recursive: true });
const catalog = JSON.parse(await readFile(join(kitRoot, "references/templates.json"), "utf8"));
const pins = JSON.parse(await readFile(join(kitRoot, "references/sdk-versions.json"), "utf8"));
const report = { schema: 1, task: "H-C7-P2 templates gate", status: "running",
  startedAt: new Date().toISOString(), node: process.version, pins: pins.engines, templates: [] };
console.log(`[hc7p2-templates] kit: ${kitRoot}\n[hc7p2-templates] evidence: ${reportDir}`);

async function assertDistBuilt() {
  for (const path of ["dist/index.js", "dist/app/index.js", "dist/webgpu/index.js"]) {
    await realpath(join(root, "packages/deep-engine", path)).catch(() => {
      throw new Error(`packages/deep-engine dist missing (${path}); run: pnpm --filter @bim-studio/deep-engine build`);
    });
  }
}

async function verifyPinsAgainstWorkspace() {
  const engine = JSON.parse(await readFile(join(root, "packages/deep-engine/package.json"), "utf8"));
  const declared = { ...engine.dependencies, ...engine.devDependencies };
  assert.equal(pins.engines["@bim-studio/deep-engine"], engine.version,
    `sdk-versions.json pin drifted from packages/deep-engine. Action: ${pins.upgradeDetection.onDrift}`);
  assert.equal(pins.engines["@webgpu/types"], declared["@webgpu/types"],
    `@webgpu/types pin drifted from packages/deep-engine dependency declaration. Action: ${pins.upgradeDetection.onDrift}`);
}

/** 模板门自带打包（不改共享 lib：@webgpu/types 现挂 devDependencies，组别校验由 pin 检查承担）。 */
async function packTemplateDependencies({ workspace, pnpm }) {
  const { createHash } = await import("node:crypto");
  const archiveDir = join(workspace, "archives"); await mkdir(archiveDir, { recursive: true });
  const engineDir = join(root, "packages/deep-engine");
  const targets = [
    { cwd: engineDir, label: "deep-engine", required: ["dist/index.js", "dist/index.d.ts",
      "dist/app/index.js", "dist/app/index.d.ts", "dist/webgpu/index.js", "dist/webgpu/index.d.ts"] },
    { cwd: await realpath(join(engineDir, "node_modules/@webgpu/types")), label: "webgpu-types",
      required: ["dist/index.d.ts"] },
  ];
  const packed = [];
  for (const target of targets) {
    const sourceText = await readFile(join(target.cwd, "package.json"), "utf8");
    const source = JSON.parse(sourceText);
    for (const hook of ["prepack", "prepare", "postpack"]) {
      assert.equal(source.scripts?.[hook], undefined, `${source.name} may not run ${hook} during the gate`);
    }
    for (const path of target.required) await realpath(join(target.cwd, path));
    await runLogged(process.execPath, [pnpm, "pack", "--json", "--pack-destination", archiveDir],
      { cwd: target.cwd, reportDir, label: `pack-${target.label}`, env: { npm_config_ignore_scripts: "true" } });
    assert.equal(await readFile(join(target.cwd, "package.json"), "utf8"), sourceText,
      "Packing must not mutate the source manifest");
    const archive = join(archiveDir,
      `${source.name.replace(/^@/, "").replaceAll("/", "-")}-${source.version}.tgz`);
    const entries = (await runLogged("tar", ["-tf", archive],
      { cwd: root, reportDir, label: `contents-${target.label}` })).trim().split(/\r?\n/);
    const manifest = JSON.parse(await runLogged("tar", ["-xOf", archive, "package/package.json"],
      { cwd: root, reportDir, label: `manifest-${target.label}` }));
    assert.equal(manifest.version, source.version);
    assert.ok(entries.every(path => !/(^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules)(\/|$)/.test(path)),
      `${source.name} archive leaked private files`);
    for (const path of target.required) {
      assert.ok(entries.includes(`package/${path.replaceAll("\\", "/")}`),
        `${source.name}: packed archive missing ${path}`);
    }
    packed.push({ name: source.name, version: source.version, archive,
      sha256: createHash("sha256").update(await readFile(archive)).digest("hex"),
      entries: entries.length });
  }
  const compression = await packDeepEngineCompression({ root, archiveDir, reportDir });
  packed.push({ name: compression.manifest.name, version: compression.manifest.version, archive: compression.archive,
    sha256: compression.sha256, entries: compression.entries.length });
  return packed;
}

async function installConsumerOffline({ workspace, packed, pnpm }) {
  const consumer = join(workspace, "consumer");
  for (const shared of [...catalog.sharedFiles, "templates"]) {
    await cp(join(kitRoot, shared), join(consumer, shared), { recursive: true });
  }
  const byName = new Map(packed.map(pkg => [pkg.name, pkg]));
  const dependencies = {};
  for (const [name, pinned] of Object.entries(pins.engines)) {
    const pkg = byName.get(name);
    assert.ok(pkg, `${name} was not packed`);
    assert.equal(pkg.version, pinned, `${name} packed ${pkg.version} but references pin ${pinned}`);
    dependencies[name] = `file:${pkg.archive.replaceAll("\\", "/")}`;
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "deep-engine-3d-template-consumer",
    private: true, type: "module", dependencies }, null, 2) + "\n");
  await writeFile(join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ packages: [],
    overrides: { "@webgpu/types": dependencies["@webgpu/types"], fflate: dependencies.fflate },
    registry: "http://127.0.0.1:9/", cacheDir: join(workspace, "empty-cache") }, null, 2) + "\n");
  await runLogged(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts",
    "--store-dir", join(workspace, "empty-store")],
  { cwd: consumer, reportDir, label: "install-offline", env: { npm_config_registry: "http://127.0.0.1:9/" } });
  for (const [name, pinned] of Object.entries(pins.engines)) {
    const installPath = await realpath(join(consumer, "node_modules", name));
    assert.ok(isWithin(workspace, installPath) && !isWithin(root, installPath),
      `${name} must resolve outside the monorepo`);
    const installed = JSON.parse(await readFile(join(installPath, "package.json"), "utf8"));
    assert.equal(installed.version, pinned, `Installed ${name}@${installed.version} != pinned ${pinned}`);
  }
  return consumer;
}

async function typecheckTemplate({ consumer, id }) {
  const require = createRequire(join(root, "package.json"));
  const tsc = resolve(dirname(require.resolve("typescript")), "../bin/tsc");
  await runLogged(process.execPath, [tsc, "-p", `templates/${id}/tsconfig.json`],
    { cwd: consumer, reportDir, label: `tsc-node-${id}` });
  await runLogged(process.execPath, [tsc, "-p", `templates/${id}/tsconfig.browser.json`],
    { cwd: consumer, reportDir, label: `tsc-browser-${id}` });
}

async function runNodeGate({ consumer, id }) {
  const output = await runLogged(process.execPath, [`out/node/templates/${id}/node.js`],
    { cwd: consumer, reportDir, label: `node-${id}` });
  return JSON.parse(output.trim());
}

async function bundleTemplate({ consumer, id, esbuild }) {
  const outfile = join(consumer, `out/${id}/bundle.js`);
  const result = await esbuild.build({ absWorkingDir: consumer, entryPoints: [`templates/${id}/browser.ts`],
    outfile, bundle: true, platform: "browser", format: "esm", target: "es2023", conditions: ["browser"],
    metafile: true, logLevel: "silent", tsconfig: join(consumer, `templates/${id}/tsconfig.browser.json`) });
  assert.deepEqual(result.warnings, [], `${id}: browser bundler must be warning-free`);
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some(input => input.replaceAll("\\", "/").includes("node_modules/@bim-studio/deep-engine/dist/")),
    `${id}: bundle must contain installed SDK dist code`);
  for (const input of inputs) {
    assert.ok(isWithin(consumer, resolve(consumer, input)), `${id}: unexpected external input ${input}`);
    assert.ok(!/(^|\/)(?:react|three|src)\//.test(input), `${id}: runtime must use SDK dist: ${input}`);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    assert.deepEqual(output.imports, [], `${id}: bundle must be self-contained`);
  }
  await writeFile(join(reportDir, `${id}-browser-metafile.json`), JSON.stringify(result.metafile, null, 2));
  return { outfile, inputs: inputs.length, bytes: (await readFile(outfile)).byteLength };
}

async function browserGate({ consumer, id, bundle }) {
  // runConsumerBrowser 约定 consumer 根部 index.html + /bundle.js；每模板就位各自入口页。
  await cp(join(consumer, `templates/${id}/index.html`), join(consumer, "index.html"));
  return runConsumerBrowser({ root, consumer, reportDir, bundle,
    screenshot: `${id}-browser.png`, waitFor: 'output:not([data-status="running"])',
    launchArgs: ["--enable-unsafe-webgpu"], consoleLevels: ["error"],
    readResult: async page => {
      if (await page.locator("output").getAttribute("data-status") !== "rendered") {
        throw new Error(`Browser fixture failed: ${await page.locator("output").innerText()}`);
      }
      const rendered = JSON.parse(await page.locator("output").innerText());
      // 渲染态截图（dispose 前画布仍在呈现）；runConsumerBrowser 的收尾截图发生在释放后。
      await page.screenshot({ path: join(reportDir, `${id}-rendered.png`) });
      await page.evaluate(() => globalThis.finishDeepEngineTemplate());
      await page.locator('output[data-status="passed"]').waitFor({ timeout: 30_000 });
      const passed = JSON.parse(await page.locator("output").innerText());
      return { ...passed, rendered };
    },
    validate: result => {
      assert.equal(result.template, id);
      const frame = result.rendered;
      assert.equal(frame.rendererId, "deep-webgpu");
      assert.equal(frame.frames.length, 2);
      assert.ok(frame.frames.every(item => item.drawCalls > 0), `${id}: frames must draw`);
      assert.ok(frame.frames[1].frame > frame.frames[0].frame, `${id}: frame counter must advance`);
      assert.ok(frame.pixelEvidence.distinctFromCorner > 30_000,
        `${id}: GPU readback needs a really rendered scene, got ${frame.pixelEvidence.distinctFromCorner}`);
      assert.equal(result.cancelled, true);
      assert.equal(result.sameDisposePromise, true);
      assert.equal(result.disposed, true);
    } });
}

try {
  const require = createRequire(join(root, "package.json"));
  const webRequire = createRequire(join(root, "apps/web/package.json"));
  const viteRequire = createRequire(webRequire.resolve("vite"));
  const esbuild = await import(pathToFileURL(viteRequire.resolve("esbuild")).href);
  await assertDistBuilt();
  await verifyPinsAgainstWorkspace();
  const pnpm = await locatePnpm();
  report.pnpm = (await runLogged(process.execPath, [pnpm, "--version"], { cwd: root, reportDir, label: "pnpm-version" })).trim();
  const workspace = await mkdtemp(join(tmpdir(), "hc7p2-templates-"));
  assert.ok(!isWithin(root, workspace), "Consumer workspace must live outside the monorepo");
  report.workspace = workspace;
  report.packed = await packTemplateDependencies({ workspace, pnpm });
  const consumer = await installConsumerOffline({ workspace, packed: report.packed, pnpm });
  report.consumer = consumer;
  report.typescript = require("typescript").version;
  for (const template of catalog.templates) {
    const id = template.id;
    console.log(`[hc7p2-templates] gate ${id} (${template.title})`);
    const entry = { id, title: template.title, status: "running" };
    report.templates.push(entry);
    await typecheckTemplate({ consumer, id });
    const node = await runNodeGate({ consumer, id });
    assert.equal(node.template, id);
    assert.ok(node.frames >= 6, `${id}: node gate must advance >=6 frames`);
    assert.ok(node.animated || node.eyeMoved, `${id}: node gate needs animation or camera motion`);
    assert.equal(node.disposed, true);
    assert.ok(node.instances > 0 && node.materials > 0 && node.geometries > 0);
    entry.node = node;
    entry.bundle = await bundleTemplate({ consumer, id, esbuild });
    if (cpuOnly) {
      entry.status = "cpu-passed";
      console.log(`[hc7p2-templates] CPU passed ${id}; browser pending`);
      continue;
    }
    const browser = await browserGate({ consumer, id, bundle: entry.bundle });
    entry.browser = { chromiumVersion: browser.version,
      pixelEvidence: browser.observed.rendered.pixelEvidence, animated: browser.observed.rendered.animated,
      instances: browser.observed.rendered.instances, screenshot: browser.screenshot };
    entry.status = "passed";
    console.log(`[hc7p2-templates] ${id}: passed (node=${node.frames}f, ` +
      `pixels=${entry.browser.pixelEvidence.distinctFromCorner}, bundle=${entry.bundle.bytes}B)`);
  }
  report.status = cpuOnly ? "cpu-passed" : "passed";
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error);
  process.exitCode = 1; console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`[hc7p2-templates] ${report.status}`);
}
