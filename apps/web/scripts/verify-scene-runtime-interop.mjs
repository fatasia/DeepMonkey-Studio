import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const [executableArg, mode = "--headless", ...extra] = process.argv.slice(2);
assert(executableArg && ["--headless", "--gpu"].includes(mode) && !extra.length,
  "Usage: node apps/web/scripts/verify-scene-runtime-interop.mjs <native-executable> [--headless|--gpu]");
const executable = path.resolve(executableArg);
const executableSha256 = hash(await readFile(executable));
const output = path.join(root, "test-output/deep2d/scene-interop", randomUUID());
await mkdir(output, { recursive: true });
const engineRequire = createRequire(path.join(root, "packages/deep-engine/package.json"));
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const { build } = engineRequire("esbuild");
const sharp = webRequire("sharp");
const { runtimeContentSha256 } = await import(pathToFileURL(webRequire.resolve("@bim-studio/deep-engine/runtime-package")).href);
const compiledModule = path.join(output, "compiler.mjs");
await build({ entryPoints: [path.join(root, "apps/web/src/delivery/compileSceneRuntimePackage.ts")],
  outfile: compiledModule, bundle: true, platform: "node", format: "esm", conditions: ["development"],
  metafile: true }).then(async result => {
    const inputs = await Promise.all(Object.keys(result.metafile.inputs).sort().map(async file => ({
      file: path.relative(root, path.resolve(file)).replaceAll("\\", "/"), sha256: hash(await readFile(file)),
    })));
    await writeFile(path.join(output, "compiler-inputs.json"), JSON.stringify(inputs, null, 2));
  });
const { compileSceneRuntimePackage } = await import(pathToFileURL(compiledModule).href);
const sources = JSON.parse(await readFile(path.join(root, "packages/deep-engine/lab/assets/sources.json"), "utf8"));
const imageDecoder = { async decode(image) {
  const { data, info } = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
} };
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function object(id, x = 0) {
  return { modelId: id, name: id, visible: true, opacity: 1,
    transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0.2, y: 0.3, z: 0.1 }, scale: { x: 1, y: 1, z: 1 } } };
}
function snapshot(name) {
  return { schemaVersion: 1, id: name, projectId: "interop", name, models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 5, z: 10 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" };
}
function runNative(args, success, markers = []) {
  const result = spawnSync(executable, args, { cwd: output, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.ifError(result.error);
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  assert.equal(result.status === 0, success, text);
  for (const marker of markers) assert(text.includes(marker), `Missing ${marker}: ${text}`);
  return text;
}
const results = [];
for (const name of ["Primitives", "Box", "BoxTextured"]) {
  const scene = snapshot(name);
  let sourceBytes;
  if (name === "Primitives") {
    scene.primitives = ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"]
      .map((kind, index) => ({ ...object(kind, (index - 3) * 3), kind, color: "#808080" }));
  } else {
    const source = sources.samples.find(item => item.name === name);
    assert(source, `Missing fixture provenance: ${name}`);
    sourceBytes = await readFile(path.join(root, "packages/deep-engine/lab/assets", source.file));
    assert.equal(hash(sourceBytes), source.sha256, `${name} fixture changed`);
    scene.models = [{ ...object("first", -2), assetModelId: name }, { ...object("second", 2), assetModelId: name }];
  }
  const original = structuredClone(scene);
  const result = await compileSceneRuntimePackage(scene, { packageId: `scene.interop.${name.toLowerCase()}`,
    packageVersion: "1.0.0", imageDecoder, loadModel: async () => { assert(sourceBytes); return sourceBytes; } });
  assert.deepEqual(scene, original, "Near-origin compile mutated source");
  const far = structuredClone(scene), offset = 1_000_000_000;
  for (const item of [...far.models, ...far.primitives]) for (const axis of ["x", "y", "z"]) item.transform.position[axis] += offset;
  for (const coordinate of [far.camera.position, far.camera.target]) for (const axis of ["x", "y", "z"]) coordinate[axis] += offset;
  const farOriginal = structuredClone(far);
  const distant = await compileSceneRuntimePackage(far, { packageId: `scene.interop.${name.toLowerCase()}`,
    packageVersion: "1.0.0", imageDecoder, loadModel: async () => { assert(sourceBytes); return sourceBytes; } });
  assert.deepEqual(far, farOriginal, "Large-coordinate compile mutated source");
  assert.equal(distant.evidence.recipe, "deep-scene-static-compile-v5");
  assert.deepEqual(distant.evidence.localCoordinates.origin, { x: offset, y: offset, z: offset });
  assert.equal(distant.evidence.localCoordinates.profile.id, "scene-local-coordinates-v1");
  assert.notEqual(distant.evidence.sourceSemanticHash, result.evidence.sourceSemanticHash);
  assert.notEqual(distant.evidence.compileGraphHash, result.evidence.compileGraphHash);
  const evidence = distant.evidence, runtime = distant.runtimePackage;
  assert.equal(evidence.compileGraphHash, runtimeContentSha256({ recipe: evidence.recipe, sourceSemanticHash: evidence.sourceSemanticHash,
    sourceAssets: evidence.sourceAssets, packageId: runtime.packageId, packageVersion: runtime.packageVersion,
    maxSourceBytes: evidence.maxSourceBytes, localCoordinates: evidence.localCoordinates,
    cameraHash: runtime.resources.find(resource => resource.kind === "scene-camera").contentHash.value,
    renderPacketHash: runtime.resources.find(resource => resource.kind === "render-packet").contentHash.value }));
  assert.deepEqual(distant.evidence.objectBindings, result.evidence.objectBindings);
  const { coordinateFrame: nearFrame, ...nearCamera } = result.runtimePackage.payloads[result.runtimePackage.entrypoints.camera];
  const { coordinateFrame: farFrame, ...farCamera } = distant.runtimePackage.payloads[distant.runtimePackage.entrypoints.camera];
  assert.deepEqual(farCamera, nearCamera);
  assert.notDeepEqual(farFrame.origin, nearFrame.origin);
  for (const [compiled, source] of [[result, scene], [distant, far]]) {
    const camera = compiled.runtimePackage.payloads[compiled.runtimePackage.entrypoints.camera];
    assert.equal(camera.schemaVersion, 2);
    assert.equal(runtimeContentSha256(camera.coordinateFrame), runtimeContentSha256(compiled.evidence.localCoordinates));
    for (const key of ["position", "target"]) assert.deepEqual(
      camera[key].map((value, axis) => value + camera.coordinateFrame.origin[["x", "y", "z"][axis]]),
      [source.camera[key].x, source.camera[key].y, source.camera[key].z]);
  }
  assert.notEqual(distant.evidence.targetArtifactHash, result.evidence.targetArtifactHash);
  assert.deepEqual(distant.runtimePackage.payloads[distant.runtimePackage.entrypoints.renderPacket],
    result.runtimePackage.payloads[result.runtimePackage.entrypoints.renderPacket]);
  assert.equal(hash(distant.packageJson), distant.evidence.targetArtifactHash);
  const distantFile = path.join(output, `${name}.large.runtime.json`);
  await writeFile(distantFile, distant.packageJson);
  await writeFile(path.join(output, `${name}.large.evidence.json`), JSON.stringify(distant.evidence, null, 2));
  const distantHeadless = runNative(["--headless-package", distantFile], true,
    ["Deep Runtime Package Player preflight OK:", `hash=${distant.runtimePackage.packageHash.value}`]);
  const distantGpu = mode === "--gpu" ? runNative(["--smoke-package", distantFile], true,
    [`hash=${distant.runtimePackage.packageHash.value}`, "native smoke GPU submission complete: scopes=clean callbacks=clean",
      "native smoke frame presented: 64x64"]) : null;
  results.push({ name: `${name}Large`, file: distantFile, evidence: distant.evidence, headless: distantHeadless, gpu: distantGpu,
    comparison: "near/far local camera, packet and object bindings identical; distinct origins restore authored world cameras; source unchanged" });
  assert.equal(hash(result.packageJson), result.evidence.targetArtifactHash);
  assert.equal(result.runtimePackage.schemaVersion, 3);
  const camera = result.runtimePackage.payloads[result.runtimePackage.entrypoints.camera];
  assert.equal(camera.schema, "deep-engine.scene-camera");
  assert.deepEqual(camera.position, [scene.camera.position.x, scene.camera.position.y, scene.camera.position.z]);
  assert.deepEqual(camera.target, [scene.camera.target.x, scene.camera.target.y, scene.camera.target.z]);
  assert(result.evidence.compiledSceneFields.some(field => field.capability === "deep.scene.camera.v1" && field.resourceId === camera.id));
  const file = path.join(output, `${name}.runtime.json`);
  await writeFile(file, result.packageJson);
  await writeFile(path.join(output, `${name}.evidence.json`), JSON.stringify(result.evidence, null, 2));
  const packet = result.runtimePackage.payloads[result.runtimePackage.entrypoints.renderPacket];
  const headless = runNative(["--headless-package", file], true, ["Deep Runtime Package Player preflight OK:",
    `hash=${result.runtimePackage.packageHash.value}`, `geometries=${packet.geometries.length} `,
    `instances=${packet.instances.length} `]);
  const gpu = mode === "--gpu" ? runNative(["--smoke-package", file], true,
    [`hash=${result.runtimePackage.packageHash.value}`, "native smoke GPU submission complete: scopes=clean callbacks=clean",
      "native smoke frame presented: 64x64"]) : null;
  const tampered = JSON.parse(result.packageJson);
  tampered.packageVersion = "9.9.9";
  const brokenFile = path.join(output, `${name}.tampered.json`);
  await writeFile(brokenFile, JSON.stringify(tampered));
  const rejection = runNative(["--headless-package", brokenFile], false, ["runtime package hash mismatch"]);
  assert(!rejection.includes("Player preflight OK"));
  results.push({ name, file, evidence: result.evidence, headless, gpu, rejection });
}
await writeFile(path.join(output, "report.json"), JSON.stringify({ executable, executableSha256,
  compilerBundleSha256: hash(await readFile(compiledModule)), mode, scope: "static-runtime-interop", results }, null, 2));
console.log(JSON.stringify({ passed: true, cases: results.length, mode, executableSha256, output }));
