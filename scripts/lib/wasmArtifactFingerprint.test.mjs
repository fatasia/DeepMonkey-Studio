import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { test } from "node:test";
import { artifactSha256, wasmSourceFingerprint } from "./wasmArtifactFingerprint.mjs";

test("wasm input fingerprint changes with shared Rust and embedded shader assets", () => {
  const repo = mkdtempSync(join(tmpdir(), "wasm-fingerprint-"));
  const files = [
    "packages/deep-engine-wasm/Cargo.toml",
    "packages/deep-engine-wasm/Cargo.lock",
    "packages/deep-engine-wasm/src/lib.rs",
    "packages/deep-engine-native/Cargo.toml",
    "packages/deep-engine-native/build.rs",
    "packages/deep-engine-native/rust-toolchain.toml",
    "scripts/build-wasm-bundle.mjs",
    "scripts/lib/wasmArtifactFingerprint.mjs",
    "packages/deep-engine-native/src/physics.rs",
    "packages/deep-engine-native/assets/shaders/main.wgsl",
  ];
  try {
    for (const file of files) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), "original");
    }
    const first = wasmSourceFingerprint(repo);
    assert.deepEqual(wasmSourceFingerprint(repo), first);
    writeFileSync(join(repo, "packages/deep-engine-native/src/physics.rs"), "changed");
    const rust = wasmSourceFingerprint(repo);
    assert.notEqual(rust.sha256, first.sha256);
    writeFileSync(join(repo, "packages/deep-engine-native/assets/shaders/main.wgsl"), "changed");
    assert.notEqual(wasmSourceFingerprint(repo).sha256, rust.sha256);
    assert.equal(artifactSha256(join(repo, "packages/deep-engine-native/src/physics.rs")).length, 64);
  } finally {
    const target = realpathSync(repo);
    const tempRoot = realpathSync(tmpdir());
    assert.ok(target.startsWith(tempRoot + sep) && basename(target).startsWith("wasm-fingerprint-"));
    rmSync(target, { recursive: true, force: true });
  }
});
