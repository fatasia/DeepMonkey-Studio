import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createNativeSceneCandidateCompiler, createVerifiedNativeSceneCandidateAssessor } from "./nativeSceneCandidateCompiler.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
let compileNativeSceneCandidate: ReturnType<typeof createNativeSceneCandidateCompiler>;
let directory: string;
beforeAll(async () => {
 directory = await mkdtemp(path.join(tmpdir(), "api-candidate-compiler-"));
 await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../../scripts/build-native-scene-compiler.mjs", import.meta.url)), "--output", directory]);
 compileNativeSceneCandidate = createNativeSceneCandidateCompiler(pathToFileURL(directory + path.sep));
}, 30_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
function scene(): SceneSnapshot {
 return { schemaVersion: 1, id: "test", projectId: "default", name: "test", models: [], primitives: [], measurements: [],
 camera: { mode: "orbit", position: { x: 1e9, y: 5, z: 10 }, target: { x: 1e9, y: 0, z: 0 } }, createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" };
}
const options = () => ({ scene: scene(), models: new Map<string, Uint8Array>(), packageId: "api.candidate", packageVersion: "1.0.0" });
it("compiles real v5 in isolation with deterministic frozen input and no mappings supplied", async () => {
 const input = options(), before = structuredClone(input.scene);
 const result = await compileNativeSceneCandidate(input);
 expect(result.evidence.recipe).toBe("deep-scene-static-compile-v5");
 expect(result.evidence.localCoordinates).toMatchObject({ origin: { x: 1e9, y: 0, z: 0 } });
 expect(createHash("sha256").update(result.packageJson).digest("hex")).toBe(result.evidence.targetArtifactHash);
 expect(result.compilerSha256).toMatch(/^[a-f0-9]{64}$/); expect(input.scene).toEqual(before);
});
it("uses actual frozen GLB bytes and rejects missing model", async () => {
 const input = options(); input.scene.models = [{ modelId: "instance", assetModelId: "asset", name: "Model", visible: true, opacity: 1,
 transform: { position: { x: 1e9, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
 await expect(compileNativeSceneCandidate(input)).rejects.toThrow("冻结模型缺失");
 const bytes = await readFile(new URL("../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
 input.models.set("asset", bytes);
 const promise = compileNativeSceneCandidate(input); bytes.fill(0); input.scene.name = "edited";
 const result = await promise; expect(result.evidence.sourceAssets).toHaveLength(1);
 expect(JSON.parse(result.packageJson).payloads["scene.main"].instances).toHaveLength(1);
});
it("rejects over budget and cancels active worker without leaking work", async () => {
 await expect(compileNativeSceneCandidate({ ...options(), maxSourceBytes: 0 })).rejects.toThrow("预算");
 await expect(compileNativeSceneCandidate({ ...options(), models: new Map([["a", new Uint8Array(3)]]), maxSourceBytes: 2 })).rejects.toThrow("预算");
 const controller = new AbortController(); const operation = compileNativeSceneCandidate({ ...options(), signal: controller.signal }); controller.abort();
 await expect(operation).rejects.toThrow();
 const result = await compileNativeSceneCandidate(options()); expect(result.packageJson).toContain("api.candidate");
});

it("decodes embedded texture offline using API sharp", async () => {
 const input = options(); input.scene.models = [{ modelId: "textured", assetModelId: "asset", name: "Texture", visible: true, opacity: 1,
 transform: { position: { x: 1e9, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
 const bytes = await readFile(new URL("../../../packages/deep-engine/lab/assets/BoxTextured.glb", import.meta.url)); input.models.set("asset", bytes);
 const provenance = JSON.parse(await readFile(new URL("../../../packages/deep-engine/lab/assets/sources.json", import.meta.url), "utf8"));
 expect(createHash("sha256").update(bytes).digest("hex")).toBe(provenance.samples.find((item: { name: string }) => item.name === "BoxTextured").sha256);
 const result = await compileNativeSceneCandidate({ ...input, signal: AbortSignal.timeout(12_000) });
 expect(JSON.parse(result.packageJson).payloads["scene.main"].textures.length).toBeGreaterThan(0);
}, 15_000);
it("terminates a worker cancelled during startup and allows a later compile", async () => {
 const controller = new AbortController(); const operation = compileNativeSceneCandidate({ ...options(), signal: controller.signal });
 const timer = setTimeout(() => controller.abort(new Error("cancel active")), 25);
 try { await expect(operation).rejects.toThrow("cancel active"); } finally { clearTimeout(timer); }
 expect((await compileNativeSceneCandidate(options())).evidence.recipe).toBe("deep-scene-static-compile-v5");
});

it("defaults package identity like Web and reports unsupported semantics without ready evidence", async () => {
 const result = await compileNativeSceneCandidate({ scene: scene(), models: new Map() });
 expect(JSON.parse(result.packageJson).packageId).toMatch(/^scene\.[a-f0-9]{64}$/);
 expect(result.report.status).toBe("blocked");
 const input = scene(); input.scripts = [{ id: "script", name: "script", enabled: true, code: "export default {}" }] as SceneSnapshot["scripts"];
 const withScript = await compileNativeSceneCandidate({ scene: input, models: new Map() });
 expect(withScript.report.items.some(item => item.capability === "deep.scene.uncompiled.v1")).toBe(true);
});

it("fails closed for missing or modified compiler deployment", async () => {
 const unavailable = createNativeSceneCandidateCompiler(pathToFileURL(path.join(directory, "missing") + path.sep));
 await expect(unavailable(options())).rejects.toThrow("不可用");
 const manifestPath = path.join(directory, "manifest.json"), original = await readFile(manifestPath);
 try {
  const manifest = JSON.parse(original.toString()); manifest.compilerSha256 = "0".repeat(64); await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(compileNativeSceneCandidate(options())).rejects.toThrow("内容校验失败");
 } finally { await writeFile(manifestPath, original); }
});

it("reassesses server compilation without reloading models and rejects wrong bundle or bytes", async () => {
 const compiled = await compileNativeSceneCandidate(options());
 const assess = createVerifiedNativeSceneCandidateAssessor(pathToFileURL(directory + path.sep));
 const runtimeEvidence = ["deep.scene.runtime.v1", "deep.scene.camera.v1"].map(capability => ({ id: `test-${capability}`, capability,
 target: "deep-native" as const, sourceSemanticHash: String(compiled.evidence.sourceSemanticHash), compileGraphHash: String(compiled.evidence.compileGraphHash),
 targetArtifactHash: String(compiled.evidence.targetArtifactHash), fixtureId: `scene-${compiled.evidence.sourceSemanticHash}`, platform: "windows-x64", scope: "native-window" as const }));
 expect((await assess({ scene: scene(), compiled, runtimeEvidence })).status).toBe("ready");
 await expect(assess({ scene: scene(), compiled: { ...compiled, compilerSha256: "0".repeat(64) }, runtimeEvidence })).rejects.toThrow("身份已变化");
 await expect(assess({ scene: scene(), compiled: { ...compiled, packageJson: compiled.packageJson + " " }, runtimeEvidence })).rejects.toThrow("身份已变化");
 const changed = scene(); changed.camera.position.z++;
 expect((await assess({ scene: changed, compiled, runtimeEvidence })).status).toBe("blocked");
});

it.each([false, true])("compiles under actual development tsx loader (watch=%s)", async watch => {
 const entry = path.join(directory, "tsx-parent.mjs");
 const moduleUrl = new URL("./nativeSceneCandidateCompiler.ts", import.meta.url).href;
 await writeFile(entry, `import { createNativeSceneCandidateCompiler, createVerifiedNativeSceneCandidateAssessor } from ${JSON.stringify(moduleUrl)};
 const directory = new URL(${JSON.stringify(pathToFileURL(directory + path.sep).href)});
 const scene = ${JSON.stringify(scene())};
 const compile = createNativeSceneCandidateCompiler(directory);
 const compiled = await compile({ scene, models: new Map() });
 const report = await createVerifiedNativeSceneCandidateAssessor(directory)({ scene, compiled, runtimeEvidence: [] });
 console.log(JSON.stringify({ recipe: compiled.evidence.recipe, status: report.status }));`);
 if (watch) {
  const output = await new Promise<string>((resolve, reject) => {
   const child = spawn(process.execPath, ["--watch", "--conditions=development", "--import", "tsx", entry], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
   });
   let stdout = "", stderr = "", completed = false;
   const timer = setTimeout(() => { child.kill(); reject(new Error(`watch timeout: ${stderr}`)); }, 15_000);
   child.stdout.on("data", value => { stdout += value; if (stdout.includes('"recipe":"deep-scene-static-compile-v5"')) { completed = true; child.kill(); } });
   child.stderr.on("data", value => { stderr += value; });
   child.once("error", error => { clearTimeout(timer); reject(error); });
   child.once("close", () => { clearTimeout(timer); if (completed) resolve(stdout); else reject(new Error(stderr)); });
  });
  expect(output).toContain('"status":"blocked"'); return;
 }
 const result = await promisify(execFile)(process.execPath, ["--conditions=development", "--import", "tsx", entry], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15_000,
 });
 expect(JSON.parse(result.stdout.trim())).toEqual({ recipe: "deep-scene-static-compile-v5", status: "blocked" });
}, 20_000);
