import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wasmSourceFingerprint } from "./lib/wasmArtifactFingerprint.mjs";

assert.equal(process.platform, "win32", "This archive targets Windows x64");
assert.ok(process.argv.slice(2).every(arg => arg === "--crt-static"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const native = join(root, "packages/deep-engine-native");
const cargo = await readFile(join(native, "Cargo.toml"), "utf8");
assert.equal(/^version = "([^"]+)"/m.exec(cargo)?.[1], version);
assert.match(version, /^\d+\.\d+\.\d+$/);
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
assert.equal(revision.status, 0);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function sourceFingerprint() {
  return { shared: wasmSourceFingerprint(root), nativeCargoLockSha256: sha(await readFile(join(native, "Cargo.lock"))) };
}
const before = await sourceFingerprint();
const crtStatic = true;
const target = "x86_64-pc-windows-msvc";
const env = { ...process.env, CARGO_BUILD_JOBS: "2" };
if (crtStatic) env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -C target-feature=+crt-static`.trim();
const child = spawn("cargo", ["build", "--manifest-path", join(native, "Cargo.toml"), "--locked", "--release",
  "--target", target, "--bin", "deep-engine-native", "-j2"], { cwd: root, env, stdio: "inherit", windowsHide: true });
const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); });
assert.equal(code, 0, "Native release build failed");
const after = await sourceFingerprint();
assert.deepEqual(after, before, "Shared Native/WASM sources changed during the release build");
const executable = await readFile(join(native, "target", target, "release/deep-engine-native.exe"));
assert.equal(executable.toString("ascii", 0, 2), "MZ");
const pe = executable.readUInt32LE(0x3c);
assert.equal(executable.readUInt32LE(pe), 0x4550);
assert.equal(executable.readUInt16LE(pe + 4), 0x8664, "Native release must be AMD64");
assert.equal(executable.readUInt16LE(pe + 24), 0x20b, "Native release must use PE32+");
const sections = pe + 24 + executable.readUInt16LE(pe + 20);
function fileOffset(rva) {
  for (let index = 0; index < executable.readUInt16LE(pe + 6); index++) {
    const section = sections + index * 40, start = executable.readUInt32LE(section + 12);
    const size = Math.max(executable.readUInt32LE(section + 8), executable.readUInt32LE(section + 16));
    if (rva >= start && rva < start + size) return executable.readUInt32LE(section + 20) + rva - start;
  }
  throw new Error(`Unmapped Native PE import RVA ${rva}`);
}
const importRva = executable.readUInt32LE(pe + 24 + 112 + 8), importedLibraries = [];
if (importRva) {
  const directory = fileOffset(importRva);
  for (let index = 0; index < 256; index++) {
    const nameRva = executable.readUInt32LE(directory + index * 20 + 12);
    if (!nameRva) break;
    const nameOffset = fileOffset(nameRva), end = executable.indexOf(0, nameOffset);
    assert.ok(end >= nameOffset && end - nameOffset < 512);
    importedLibraries.push(executable.toString("ascii", nameOffset, end));
  }
}
assert.ok(importedLibraries.length > 0);
assert.ok(importedLibraries.every(name => !/^(vcruntime|msvcp|concrt)/i.test(name)), "Offline Native must not import redistributable VC runtime DLLs");
const identity = { schemaVersion: 1, version, target, crt: crtStatic ? "static" : "dynamic",
  revision: revision.stdout.trim(), sourceFingerprint: after,
  sourceScope: "wasmSourceFingerprint: Native src/assets/geometryDag, mirrored WASM and their manifests/build inputs",
  build: { profile: "release", features: [], jobs: 2, rustflags: env.RUSTFLAGS ?? "" },
  executable: { filename: "deep-engine-native.exe", bytes: executable.length, sha256: sha(executable), importedLibraries } };
const stage = await mkdtemp(join(tmpdir(), "studio-native-release-"));
await writeFile(join(stage, identity.executable.filename), executable);
await writeFile(join(stage, "BUILD-IDENTITY.json"), JSON.stringify(identity, null, 2) + "\n");
await writeFile(join(stage, "USAGE.md"), `# Deep Engine Native ${version}\n\nWindows x64 viewer for exported runtime packages.\n\n\`deep-engine-native.exe --package runtime-package.json\`\n\nUse \`--help\` for the existing CLI. Runtime packages and their referenced resources stay together. ${crtStatic ? "The C runtime is linked into the executable." : "Install the Microsoft Visual C++ x64 runtime before first use."}\n`);
for (const filename of ["LICENSE", "LICENSE.zh-CN.md", "LICENSING.md", "THIRD_PARTY_NOTICES.md"])
  await cp(join(root, filename), join(stage, filename));
const output = join(root, "artifacts/releases", version);
await mkdir(output, { recursive: true });
const archive = join(output, `DeepMonkey-Native-${version}-windows-x64.zip`);
// bsdtar 会把 "D:\..." 的盘符冒号当远程主机分隔符;切到输出目录用相对文件名。
const packed = spawnSync("tar", ["-a", "-cf", basename(archive), "-C", stage, "."], { cwd: output, encoding: "utf8", windowsHide: true });
assert.equal(packed.status, 0, packed.stderr);
const archiveBytes = await readFile(archive);
const result = { ...identity, archive, bytes: archiveBytes.length, sha256: sha(archiveBytes) };
await writeFile(join(output, `DeepMonkey-Native-${version}-windows-x64.json`), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
