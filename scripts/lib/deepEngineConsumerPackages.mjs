import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWithin, runLogged } from "./sdkConsumerPackages.mjs";

export async function packDeepEngineConsumerDependencies({ root, workspace, reportDir, pnpm }) {
  const archiveDir = join(workspace, "archives"); await mkdir(archiveDir);
  const engineDir = join(root, "packages/deep-engine");
  const engine = await packPackage({ cwd: engineDir, archiveDir, reportDir, pnpm,
    label: "deep-engine", required: ["dist/index.js", "dist/index.d.ts", "dist/app/index.js", "dist/app/index.d.ts",
      "dist/webgpu/index.js", "dist/webgpu/index.d.ts"] });
  assert.equal(engine.manifest.private, true, "Deep Engine remains a private source-available workspace package");
  // @webgpu/types 是 types-only 包,现挂 engine manifest 的 devDependencies(与
  // version-pin.test.mjs 的合并声明口径一致);外部消费者的类型解析由下方单独 pack
  // @webgpu/types + consumer 直接依赖 + pnpm override 保证,不依赖 engine 的 dependencies 组。
  const declaredWebgpuTypes = { ...engine.manifest.dependencies, ...engine.manifest.devDependencies }["@webgpu/types"];
  assert.equal(declaredWebgpuTypes, "0.1.72", "WebGPU declarations must be pinned to an exact version in the engine manifest");
  assert.ok(engine.entries.includes("package/dist/app/index.js") && engine.entries.includes("package/dist/app/index.d.ts"));
  const webgpuDir = await realpath(join(engineDir, "node_modules/@webgpu/types"));
  const webgpu = await packPackage({ cwd: webgpuDir, archiveDir, reportDir, pnpm,
    label: "webgpu-types", required: ["dist/index.d.ts"] });
  assert.equal(webgpu.manifest.name, "@webgpu/types");
  assert.equal(webgpu.manifest.version, "0.1.72");
  return [engine, webgpu].map(pkg => ({ name: pkg.manifest.name, version: pkg.manifest.version,
    archive: pkg.archive, sha256: pkg.sha256, entries: pkg.entries.length }));
}

export async function installDeepEngineConsumer({ root, workspace, reportDir, pnpm, packed }) {
  const consumer = join(workspace, "consumer");
  await cp(join(root, "scripts/fixtures/deep-engine-consumer"), consumer, { recursive: true });
  const dependencies = Object.fromEntries(packed.map(pkg => [pkg.name, `file:${pkg.archive.replaceAll("\\", "/")}`]));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "deep-engine-external-consumer",
    private: true, type: "module", dependencies }, null, 2) + "\n");
  await writeFile(join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ packages: [],
    overrides: { "@webgpu/types": dependencies["@webgpu/types"] },
    registry: "http://127.0.0.1:9/", cacheDir: join(workspace, "empty-cache") }, null, 2) + "\n");
  await runLogged(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts", "--store-dir", join(workspace, "empty-store")],
    { cwd: consumer, reportDir, label: "install-offline", env: { npm_config_registry: "http://127.0.0.1:9/" } });
  const installed = [];
  for (const pkg of packed) {
    const path = await realpath(join(consumer, "node_modules", pkg.name));
    assert.ok(isWithin(workspace, path) && !isWithin(root, path), `${pkg.name} must resolve outside the monorepo`);
    installed.push({ name: pkg.name, path });
  }
  assert.ok((await readdir(join(workspace, "empty-store"))).length > 0, "The isolated install must populate its empty store");
  return { consumer, installed };
}

async function packPackage({ cwd, archiveDir, reportDir, pnpm, label, required }) {
  const sourceText = await readFile(join(cwd, "package.json"), "utf8"), source = JSON.parse(sourceText);
  for (const hook of ["prepack", "prepare", "postpack"]) {
    assert.equal(source.scripts?.[hook], undefined, `${source.name} may not run ${hook} during the gate`);
  }
  for (const path of required) await access(join(cwd, path));
  await runLogged(process.execPath, [pnpm, "pack", "--json", "--pack-destination", archiveDir],
    { cwd, reportDir, label: `pack-${label}`, env: { npm_config_ignore_scripts: "true" } });
  assert.equal(await readFile(join(cwd, "package.json"), "utf8"), sourceText, "Packing must not mutate the source manifest");
  const filename = `${source.name.replace(/^@/, "").replaceAll("/", "-")}-${source.version}.tgz`;
  const archive = join(archiveDir, filename);
  const entries = (await runLogged("tar", ["-tf", archive], { cwd, reportDir, label: `contents-${label}` })).trim().split(/\r?\n/);
  const manifest = JSON.parse(await runLogged("tar", ["-xOf", archive, "package/package.json"],
    { cwd, reportDir, label: `manifest-${label}` }));
  assert.ok(entries.every(path => !/(^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules)(\/|$)/.test(path)), `${source.name} archive leaked private files`);
  return { manifest, archive, entries, sha256: createHash("sha256").update(await readFile(archive)).digest("hex") };
}
