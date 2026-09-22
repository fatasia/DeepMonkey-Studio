// 场景剖切端到端:同一 GI 房间场景,enabled axis 剖切编译进相机 v3,Native 渲染像素必须与未剖切不同且重复稳定。
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileNativeSceneCandidate } from "../apps/api/src/nativeSceneCandidateCompiler.js";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const [exeArg, glbDirArg, outputArg] = process.argv.slice(2);
assert(exeArg, "Expected <native.exe> [gi-glb-directory] [output-directory]");
const output = path.resolve(outputArg ?? "test-output/scene-clipping-e2e-20260918");
await mkdir(output, { recursive: true });
const executable = path.join(output, "verified-player.exe");
// Permit re-running into an existing evidence directory (or while an earlier
// capture still owns the executable) without copying a file onto itself.
if (path.resolve(exeArg) !== executable) await copyFile(path.resolve(exeArg), executable);
const radius = Math.hypot(3, 1.5, 3), distance = radius / Math.sin(25 * Math.PI / 180) * 1.05, normal = Math.hypot(6, 4, 7);
const base: SceneSnapshot = { schemaVersion: 1, id: "baked-gi", projectId: "default", name: "Scene clipping e2e", createdAt: "", updatedAt: "",
  models: [{ modelId: "room", assetModelId: "room", name: "Baked room", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  primitives: [], measurements: [],
  camera: { mode: "orbit", position: { x: 6 * distance / normal, y: 1.5 + 4 * distance / normal, z: 7 * distance / normal }, target: { x: 0, y: 1.5, z: 0 } },
  environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
  lighting: { enabled: true, intensity: 1, shadowsEnabled: false, reflectionsEnabled: false, globalIlluminationEnabled: false, lights: [] },
  clipping: { enabled: true, mode: "axis", axis: "z", offset: 1.0, inverted: false, showHelper: false } };
const glbDir = path.resolve(glbDirArg ?? "test-output/lightmap-gi-20260918");
const sourcePath = path.join(glbDir, "round-1-gi-on.glb");
const source = await readFile(sourcePath);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const clientPixels: Buffer[] = [], evidence: unknown[] = [];
for (const [index, [variant, scene]] of ([
  ["clipped", base],
  ["open", { ...base, clipping: { ...base.clipping!, enabled: false } }],
] as [string, SceneSnapshot][]).entries()) {
  const compiled = await compileNativeSceneCandidate({ scene, packageId: `scene.clipping.${variant}`, packageVersion: "1.0.0", models: new Map([["room", source]]) });
  const runtime = JSON.parse(compiled.packageJson);
  const camera = Object.values(runtime.payloads).find((payload: any) => payload?.schema === "deep-engine.scene-camera") as any;
  const file = path.join(output, `${variant}.runtime.json`);
  await writeFile(file, compiled.packageJson);
  const captures = [];
  const pixels: Buffer[] = [];
  for (const round of [1, 2]) {
    const capture = await captureNativePlayerWindow({ label: `${variant}-${round}`, executable, args: ["--package", file],
      outputDirectory: output, presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60000 });
    const match = /client=(\d+)x(\d+) dpi=\d+ clientOffset=(\d+),(\d+)/.exec(capture.captureLog);
    assert(match, capture.captureLog);
    const [width, height, left, top] = match.slice(1).map(Number) as [number, number, number, number];
    pixels.push(await sharp(capture.png).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer());
    captures.push({ round, clientRgbaSha256: sha(pixels[round - 1]!) });
  }
  assert(pixels[0]!.equals(pixels[1]!), `${variant} repeat captures must be stable`);
  clientPixels[index] = pixels[0]!;
  evidence.push({ variant, camera: { schemaVersion: camera.schemaVersion, clippingPlane: camera.clippingPlane ?? null },
    compiledClipping: compiled.evidence.compiledSceneFields.find((field: any) => field.field === "clipping") ?? null,
    deferred: compiled.evidence.deferredSceneFields, captures, runtimeSha256: sha(Buffer.from(compiled.packageJson)) });
}
assert(!clientPixels[0]!.equals(clientPixels[1]!), "Clipping must change rendered pixels");
let changed = 0;
for (let i = 0; i < clientPixels[0]!.length; i += 1) if (clientPixels[0]![i] !== clientPixels[1]![i]) changed += 1;
assert(changed > 10000, `Clipping must move a substantial pixel set, got ${changed}`);
await writeFile(path.join(output, "evidence.json"), JSON.stringify({
  schemaVersion: 1,
  source: { path: path.relative(repo(), sourcePath), sha256: sha(source), bytes: source.byteLength },
  executable: { path: path.relative(repo(), executable), sha256: sha(await readFile(executable)), bytes: (await readFile(executable)).byteLength },
  changedBytes: changed,
  cells: evidence,
}, null, 2));
console.log(`Scene clipping e2e passed: changedBytes=${changed} (${(changed / clientPixels[0]!.length * 100).toFixed(2)}% of client bytes)`);
function repo() { return path.resolve(import.meta.dirname, ".."); }
