import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  assertSceneViewerViteManifest,
  createSceneViewerPayload,
  createTauriOverlay,
  fetchPublishedSource,
  injectDeliveryMarker,
  pruneSceneViewerFrontend,
  resolveSceneViewerBuildPaths,
  sceneViewerWebBuildEnvironment,
  sha256,
  writeSceneViewerPayload,
} from "./scene-viewer-package-core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const workspaceDirectory = path.resolve(desktopDirectory, "../..");
const options = parseArguments(process.argv.slice(2));

async function main() {
  const source = await fetchPublishedSource(options);
  const packageId = options.packageId ?? sha256(`${source.publication.sceneId}:${source.publication.publishedAt}`).slice(0, 16).toLowerCase();
  const productName = options.productName ?? `${safeProductName(source.publication.name)} 浏览器`;
  const identifier = options.identifier ?? `com.industrialstudio.sceneviewer.${packageId}`;
  const { buildRoot, frontendDirectory, generatedWebDist, webDist } = resolveSceneViewerBuildPaths(
    desktopDirectory,
    packageId,
    options.webDist,
  );

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  if (!options.webDist) {
    await run(
      "pnpm",
      ["--filter", "@bim-studio/web", "build:scene-viewer"],
      workspaceDirectory,
      sceneViewerWebBuildEnvironment(generatedWebDist),
    );
  }
  await cp(webDist, frontendDirectory, { recursive: true });
  const frontendBytesBeforePruning = await directoryBytes(frontendDirectory);
  const viteManifest = JSON.parse(await readFile(path.join(frontendDirectory, ".vite", "manifest.json"), "utf8"));
  assertSceneViewerViteManifest(viteManifest);

  const payload = await createSceneViewerPayload(source, {
    ...options,
    packageId,
  });
  const pruning = await pruneSceneViewerFrontend(frontendDirectory, payload.manifest, viteManifest);
  await writeFile(path.join(frontendDirectory, ".vite", "manifest.json"), `${JSON.stringify(viteManifest, null, 2)}\n`, "utf8");
  const frontendBytesAfterPruning = await directoryBytes(frontendDirectory);
  await writeSceneViewerPayload(payload, frontendDirectory);
  const indexPath = path.join(frontendDirectory, "index.html");
  await writeFile(indexPath, injectDeliveryMarker(await readFile(indexPath, "utf8")), "utf8");

  const configPath = path.join(desktopDirectory, "src-tauri", "scene-viewer.generated.conf.json");
  const overlay = createTauriOverlay({
    productName,
    identifier,
    version: options.version ?? "0.1.0",
    frontendDist: `../.scene-viewer-build/${packageId}/frontend`,
  });
  await writeFile(configPath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
  await writeFile(path.join(buildRoot, "build-evidence.json"), `${JSON.stringify({
    packageId,
    productName,
    identifier,
    sceneId: source.publication.sceneId,
    projectId: source.publication.projectId,
    publishedAt: source.publication.publishedAt,
    rendererMode: payload.manifest.rendererMode,
    toolbarVisible: payload.manifest.toolbarVisible,
    sourcePublicationSha256: payload.manifest.sourcePublicationSha256,
    publicationSha256: payload.manifest.publicationSha256,
    assetCount: payload.manifest.assets.length,
    assetBytes: payload.manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    pruning,
    frontendBytesBeforePruning,
    frontendBytesAfterPruning,
    frontendBytesRemoved: frontendBytesBeforePruning - frontendBytesAfterPruning,
    frontendDirectory,
    configPath,
  }, null, 2)}\n`, "utf8");

  if (!options.stageOnly) {
    await run("pnpm", ["exec", "tauri", "build", "--config", configPath], desktopDirectory);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, packageId, productName, frontendDirectory, configPath, bundled: !options.stageOnly }, null, 2)}\n`);
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--stage-only") {
      values.stageOnly = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`无法识别参数：${item}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数缺少值：${item}`);
    values[toCamelCase(item.slice(2))] = value;
    index += 1;
  }
  values.token = values.token ?? (values.tokenEnv ? process.env[values.tokenEnv] : undefined);
  if (values.toolbar && !["published", "show", "hide"].includes(values.toolbar)) throw new Error("--toolbar 只允许 published、show、hide");
  if (values.renderer && !["published", "webgl", "webgpu-preferred"].includes(values.renderer)) throw new Error("--renderer 只允许 published、webgl、webgpu-preferred");
  return { toolbar: "published", renderer: "published", ...values };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function safeProductName(value) {
  return value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || "场景";
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(target) : (await stat(target)).size;
  }
  return total;
}

function run(command, args, cwd, extraEnvironment = {}) {
  const pnpmRuntime = command === "pnpm" ? process.env.npm_execpath : undefined;
  const executable = pnpmRuntime ? process.execPath : command;
  const executableArguments = pnpmRuntime ? [pnpmRuntime, ...args] : args;
  return new Promise((resolve, reject) => {
    // 优先通过当前 pnpm 的 JS 入口启动，避免 Windows .cmd shell 拼接参数。
    const child = spawn(executable, executableArguments, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32" && !pnpmRuntime,
      env: { ...process.env, ...extraEnvironment },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 执行失败，退出码 ${code}`)));
  });
}

await main();
