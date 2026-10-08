import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locatePnpm, packSdks, runLogged } from "./lib/sdkConsumerPackages.mjs";
import { packDeepEngineConsumerDependencies } from "./lib/deepEngineConsumerPackages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const output = resolve(process.argv[2] ?? join(root, "artifacts/releases", version, "sdk"));
const workspace = await mkdtemp(join(tmpdir(), "studio-release-sdk-"));
const reportDir = join(workspace, "evidence");
await mkdir(reportDir);
const stage = join(workspace, "bundle");
await mkdir(stage);
const pnpm = await locatePnpm();
const sdks = await packSdks({ root, workspace, reportDir, pnpm });
const engineWorkspace = join(workspace, "engine");
await mkdir(engineWorkspace);
const engine = await packDeepEngineConsumerDependencies({ root, workspace: engineWorkspace, reportDir, pnpm });
const packed = [...sdks, ...engine];
for (const pkg of packed.filter(pkg => pkg.name.startsWith("@bim-studio/"))) assert.equal(pkg.version, version);
await mkdir(output, { recursive: true });
const artifacts = [];
for (const pkg of packed) {
  const filename = basename(pkg.archive), bytes = await readFile(pkg.archive);
  await writeFile(join(stage, filename), bytes);
  artifacts.push({ name: pkg.name, version: pkg.version, filename, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}
await cp(join(root, "templates/deep-engine-3d"), join(stage, "templates/deep-engine-3d"), {
  recursive: true, filter: source => !source.split(/[\\/]/).some(part => ["node_modules", "dist", "test-output"].includes(part)),
});
for (const filename of ["LICENSE", "LICENSE.zh-CN.md", "LICENSING.md", "THIRD_PARTY_NOTICES.md"])
  await cp(join(root, filename), join(stage, filename));
await cp(join(root, "docs/sdk-release.md"), join(stage, "INSTALL.md"));
await writeFile(join(stage, "manifest.json"), JSON.stringify({ schemaVersion: 1, version, artifacts }, null, 2) + "\n");
const archive = join(dirname(output), `DeepMonkey-Studio-SDK-${version}.tar.gz`);
await runLogged("tar", ["-czf", archive, "-C", stage, "."], { cwd: root, reportDir, label: "bundle-sdk" });
await cp(stage, output, { recursive: true });
const bytes = await readFile(archive);
const result = { schemaVersion: 1, version, output, archive, bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), artifacts, evidence: reportDir };
await writeFile(join(dirname(output), `DeepMonkey-Studio-SDK-${version}.json`), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
