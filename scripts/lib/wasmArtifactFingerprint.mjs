import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOTS = [
  "packages/deep-engine-wasm/src",
  "packages/deep-engine-native/src",
  "packages/deep-engine-native/assets",
];
const SOURCE_FILES = [
  "packages/deep-engine-wasm/Cargo.toml",
  "packages/deep-engine-wasm/Cargo.lock",
  "packages/deep-engine-native/Cargo.toml",
  "packages/deep-engine-native/build.rs",
  "packages/deep-engine-native/rust-toolchain.toml",
  "scripts/build-wasm-bundle.mjs",
  "scripts/lib/wasmArtifactFingerprint.mjs",
];

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
}

export function wasmSourceFingerprint(repoRoot) {
  // deep-engine-wasm mirrors Native sources and depends on its Cargo crate.
  // Hash both source trees and embedded shader assets; paths are included so
  // renames also invalidate the installed bundle.
  const files = [
    ...SOURCE_FILES.map(path => join(repoRoot, path)),
    ...SOURCE_ROOTS.flatMap(path => filesUnder(join(repoRoot, path))),
  ].map(path => ({ path, name: relative(repoRoot, path).replaceAll("\\", "/") }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(readFileSync(file.path));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

export function artifactSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
