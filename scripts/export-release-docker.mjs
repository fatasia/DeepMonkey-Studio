import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { prepareDockerDeployment } from "./prepare-release-docker-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
assert.equal(revisionResult.status, 0);
const revision = revisionResult.stdout.trim(), image = `deep-monkey-studio:${version}`;
const stores = ["postgres:18-alpine", "bitnamilegacy/minio@sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c"];
const offlineMinio = "deep-monkey-minio:2025.5.24";
const output = resolve(process.argv[2] ?? join(root, "artifacts/releases", version));
await mkdir(output, { recursive: true });
async function docker(args) {
  const child = spawn("docker", args, { cwd: root, stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); });
  assert.equal(code, 0, `docker ${args[0]} failed`);
}
await docker(["build", "--build-arg", `VERSION=${version}`, "--build-arg", `REVISION=${revision}`, "--tag", image, "."]);
for (const store of stores) await docker(["pull", store]);
await docker(["tag", stores[1], offlineMinio]);
const inspected = spawnSync("docker", ["image", "inspect", image, ...stores], { encoding: "utf8", windowsHide: true });
assert.equal(inspected.status, 0, inspected.stderr);
const images = JSON.parse(inspected.stdout).map(value => ({ id: value.Id, tags: value.RepoTags, digests: value.RepoDigests,
  bytes: value.Size, architecture: value.Architecture, os: value.Os, labels: value.Config.Labels, layers: value.RootFS.Layers }));
assert.equal(images[0].labels["org.opencontainers.image.version"], version);
assert.equal(images[0].labels["org.opencontainers.image.revision"], revision);
const archive = join(output, `DeepMonkey-Studio-Docker-${version}.tar.gz`);
const savedImages = [image, stores[0], offlineMinio];
const child = spawn("docker", ["save", ...savedImages], { cwd: root, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
const ended = new Promise((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); });
await pipeline(child.stdout, createGzip({ level: 6 }), createWriteStream(archive));
assert.equal(await ended, 0, "docker save failed");
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const result = { schemaVersion: 1, version, revision, archive, bytes: (await stat(archive)).size,
  sha256: hash.digest("hex"), images, savedImages,
  offlineEnvironment: { BIM_STUDIO_MINIO_IMAGE: offlineMinio } };
await writeFile(join(output, `DeepMonkey-Studio-Docker-${version}.json`), JSON.stringify(result, null, 2) + "\n");
result.deployment = await prepareDockerDeployment({ manifest: result, output });
console.log(JSON.stringify(result, null, 2));
