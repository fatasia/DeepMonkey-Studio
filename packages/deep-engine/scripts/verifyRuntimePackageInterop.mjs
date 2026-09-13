import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { decodeGlb } from "@bim-studio/deep-engine/gltf";
import { buildDeepRuntimePackage, createRuntimeDeepSlMaterial, parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { adaptDeepSlStandardToShaderPackage } from "@bim-studio/deep-engine/shader-authoring";
import { createRuntimePackageLodInput } from "./runtimePackageLodFixture.mjs";
import { createRuntimePackageShaderInput } from "./runtimePackageShaderFixture.mjs";

// 从真实 GLB 经公开导出 API 到原生 Player，避免只验证手写的合同夹具。
const [executableArgument, mode = "--headless", ...extra] = process.argv.slice(2);
assert(executableArgument && ["--headless", "--gpu"].includes(mode) && !extra.length,
  "Usage: node scripts/verifyRuntimePackageInterop.mjs <native-executable> [--headless|--gpu]");
const executable = path.resolve(executableArgument);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "../../test-output/deep-engine/runtime-interop");
const sources = JSON.parse(await readFile(path.join(root, "lab/assets/sources.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const executableSha256 = sha256(await readFile(executable));
await mkdir(output, { recursive: true });

function runNative(arguments_, expected) {
  const result = spawnSync(executable, arguments_, { cwd: output, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  assert.ifError(result.error);
  assert.equal(result.status, 0, text);
  for (const marker of expected) assert(text.includes(marker), `Missing ${marker}: ${text}`);
  return text;
}

const results = [];
async function verifyCase(name, input, provenance, gpuMarkers = []) {
  const packet = input.renderPacket.value;
  const runtime = buildDeepRuntimePackage(input);
  const serialized = serializeDeepRuntimePackage(runtime);
  assert.equal(parseDeepRuntimePackage(serialized).valid, true);
  const file = path.join(output, `${name}-${runtime.packageHash.value}.json`);
  await writeFile(file, serialized, "utf8");
  const headless = runNative(["--headless-package", file], [
    "Deep Runtime Package Player preflight OK:", `hash=${runtime.packageHash.value}`,
    `geometries=${packet.geometries.length} `, `instances=${packet.instances.length} `,
  ]);
  const gpu = mode === "--gpu" ? runNative(["--smoke-package", file], [
    `hash=${runtime.packageHash.value}`, "native smoke GPU submission complete: scopes=clean callbacks=clean",
    "native smoke frame presented: 64x64", ...gpuMarkers,
  ]) : undefined;
  results.push({ name, ...provenance, packageHash: runtime.packageHash.value,
    serializedSha256: sha256(serialized), serializedBytes: Buffer.byteLength(serialized), file, headless, gpu });
}
for (const name of ["Box", "BoxInterleaved"]) {
  const source = sources.samples.find(candidate => candidate.name === name);
  assert(source, `Missing source provenance for ${name}.`);
  const bytes = await readFile(path.join(root, "lab/assets", source.file));
  assert.equal(sha256(bytes), source.sha256, `${name}: source bytes changed.`);
  await verifyCase(name, {
    packageId: `deep.interop.${name.toLowerCase()}`, packageVersion: "0.1.0",
    renderPacket: { id: "scene.main", revision: 1, value: decodeGlb(bytes, { resourcePrefix: `interop/${name}` }) },
  }, { sourceKind: "upstream-glb", sourceSha256: source.sha256 });
}
// LOD is authored here, not inferred from the upstream GLBs or presented as a real asset LOD chain.
await verifyCase("LOD", createRuntimePackageLodInput(), { sourceKind: "self-owned-lod-fixture" }, ["native GPU LOD v1:"]);
await verifyCase("DeepSL-LOD", createRuntimePackageShaderInput({ adaptDeepSlStandardToShaderPackage, createRuntimeDeepSlMaterial }),
  { sourceKind: "self-owned-deepsl-lod-fixture" }, ["native Player ShaderPackage materials ready: packages=3 materials=3", "native GPU LOD v1:"]);
const evidence = { schema: 1, executable, executableSha256, mode, results };
const evidenceFile = path.join(output, `verification-${Date.now()}.json`);
await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: true, mode, cases: results.length, executableSha256, evidenceFile }));
