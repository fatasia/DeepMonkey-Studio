import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const sdkPackages = ["contracts", "scene-sdk", "server-sdk"];

export function isWithin(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function runLogged(executable, args, options) {
  const { cwd, reportDir, label, timeout = 120_000, env = {} } = options;
  let output = "";
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false,
      env: { ...process.env, NODE_OPTIONS: "", COREPACK_ENABLE_NETWORK: "0", ...env } });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${label}: timed out after ${timeout} ms`)); }, timeout);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolveResult(code); });
  }).catch(async error => {
    await writeFile(join(reportDir, `${label}.log`), output + `\n${error.message}\n`);
    throw error;
  });
  await writeFile(join(reportDir, `${label}.log`), output);
  assert.equal(result, 0, `${label}: exit ${result}; see ${join(reportDir, `${label}.log`)}`);
  console.log(`[sdk-consumer] ${label}: passed`);
  return output;
}

export async function locatePnpm() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/pnpm/bin/pnpm.mjs")]
    .filter(path => path && /pnpm\.(?:mjs|cjs|js)$/.test(path));
  for (const path of candidates) {
    try { await access(path); return path; } catch { /* Check the next installed pnpm entry. */ }
  }
  throw new Error("Use the repository's installed pnpm; this gate does not download package-manager tooling.");
}

export async function packSdks({ root, workspace, reportDir, pnpm }) {
  const archiveDir = join(workspace, "archives");
  await mkdir(archiveDir);
  const packed = [];
  for (const shortName of sdkPackages) {
    const cwd = join(root, "packages", shortName);
    const sourceText = await readFile(join(cwd, "package.json"), "utf8");
    const source = JSON.parse(sourceText);
    assert.equal(source.private, true, `${source.name} must remain private`);
    for (const hook of ["prepack", "prepare", "postpack"]) {
      assert.equal(source.scripts?.[hook], undefined, `Do not let ${source.name} run an unchecked ${hook} hook`);
    }
    const exports = source.exports["."];
    const exportTargets = [exports.default, exports.types, exports.development?.default, exports.development?.types].filter(Boolean);
    for (const path of exportTargets) await access(resolve(cwd, path));
    await runLogged(process.execPath, [pnpm, "pack", "--json", "--pack-destination", archiveDir],
      { cwd, reportDir, label: `pack-${shortName}`, env: { npm_config_ignore_scripts: "true" } });
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), sourceText, "Packing must not modify the source manifest");
    const expected = `${source.name.replace(/^@/, "").replaceAll("/", "-")}-${source.version}.tgz`;
    const archive = join(archiveDir, expected);
    const entries = (await runLogged("tar", ["-tf", archive], { cwd, reportDir, label: `contents-${shortName}` }))
      .trim().split(/\r?\n/);
    const manifest = JSON.parse(await runLogged("tar", ["-xOf", archive, "package/package.json"],
      { cwd, reportDir, label: `manifest-${shortName}` }));
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.exports, source.exports);
    for (const path of exportTargets) {
      assert.ok(entries.includes(`package/${path.replace(/^\.\//, "")}`), `${source.name}: missing packed export ${path}`);
    }
    assert.ok(entries.every(path => !/(^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules)(\/|$)/.test(path)), "No secrets or install tree in tarball");
    assert.ok(!JSON.stringify(manifest.dependencies ?? {}).includes("workspace:"), `${source.name}: unresolved workspace dependency`);
    if (shortName !== "contracts") assert.equal(manifest.dependencies["@bim-studio/contracts"], packed[0].version);
    packed.push({ name: source.name, version: source.version, archive, entries: entries.length,
      exports: manifest.exports, dependencies: manifest.dependencies ?? {}, sourceManifestUnchanged: true,
      sourceFilesIncluded: entries.filter(path => path.startsWith("package/src/")).length,
      testFilesIncluded: entries.filter(path => /\.test\.[cm]?[jt]sx?$/.test(path)).length,
      sha256: createHash("sha256").update(await readFile(archive)).digest("hex") });
  }
  return packed;
}

export async function installConsumer({ root, workspace, reportDir, pnpm, packed }) {
  const consumer = join(workspace, "consumer");
  await cp(join(root, "scripts/fixtures/sdk-consumer"), consumer, { recursive: true });
  const dependencies = Object.fromEntries(packed.map(pkg => [pkg.name, `file:${pkg.archive.replaceAll("\\", "/")}`]));
  // Overrides are consumer-local: the packed SDK must still expose ordinary exact semver dependencies.
  // Pin the transitive contract to the same local tarball so an empty store needs no registry metadata.
  const manifest = { name: "bim-sdk-external-consumer", private: true, type: "module", dependencies };
  const contractOverride = { "@bim-studio/contracts": dependencies["@bim-studio/contracts"] };
  await writeFile(join(consumer, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  // pnpm 11 no longer reads package.json's pnpm field. JSON is also valid YAML.
  await writeFile(join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ packages: [], overrides: contractOverride,
    registry: "http://127.0.0.1:9/", cacheDir: join(workspace, "empty-cache") }, null, 2) + "\n");
  await runLogged(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts", "--store-dir", join(workspace, "empty-store")],
    { cwd: consumer, reportDir, label: "install-offline", env: { npm_config_registry: "http://127.0.0.1:9/" } });
  const installed = [];
  for (const pkg of packed) {
    const installedPath = await realpath(join(consumer, "node_modules", pkg.name));
    assert.ok(isWithin(workspace, installedPath) && !isWithin(root, installedPath), "SDK must be installed outside the source workspace");
    installed.push({ name: pkg.name, path: installedPath });
  }
  const storeEntries = await readdir(join(workspace, "empty-store"));
  assert.ok(storeEntries.length > 0, "The fresh external store must actually be used");
  return { consumer, installed, contractOverride };
}
