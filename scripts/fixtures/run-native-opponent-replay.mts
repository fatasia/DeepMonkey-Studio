// V02 独立 Native 对手运行证据（D24–D28/⑥）：两个结构不同的冻结运行包，
// 各自在 Native 真窗口跑两轮，产出绑定器合同要求的 runs（sceneId/round/
// frameDigestSha256/exitCode），并验证轮次重复性与场景间独立性。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repo = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const output = path.join(repo, "test-output/d24-d28-native-opponent");
const stepMs = 100;
const asImport = (p: string) => p.replaceAll("\\", "/");
const sha = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");
const requireWeb = createRequire(path.join(repo, "apps/web/package.json"));

await mkdir(output, { recursive: true });
const entry = path.join(output, "opponent-entry.ts");
await writeFile(entry, `export { compileSceneRuntimePackage } from ${JSON.stringify(asImport(path.join(repo, "apps/web/src/delivery/compileSceneRuntimePackage.ts")))};
export { serializeDeepRuntimePackage, parseDeepRuntimePackage, runtimeContentSha256, runtimePackageSha256 } from ${JSON.stringify(asImport(path.join(repo, "packages/deep-engine/src/runtimePackage/index.ts")))};
`);
const compiledModule = path.join(output, "compiler.mjs");
const { build } = createRequire(path.join(repo, "apps/web/package.json"))("esbuild");
await build({ entryPoints: [entry], outfile: compiledModule, bundle: true, platform: "node", format: "esm", conditions: ["development"], logLevel: "error" });
const compiler = await import(pathToFileURL(compiledModule).href);

interface SceneDef { sceneId: string; packageId: string; durationSeconds: number; events: Array<{ revision: number; timeMs: number }>; }
const scenes: SceneDef[] = [
  { sceneId: "workcell-a", packageId: "scene.dynamic-replay-a", durationSeconds: 1, events: [{ revision: 1, timeMs: 250 }, { revision: 2, timeMs: 750 }] },
  { sceneId: "workcell-b", packageId: "scene.dynamic-replay-b", durationSeconds: 2, events: [{ revision: 1, timeMs: 400 }, { revision: 2, timeMs: 1200 }, { revision: 3, timeMs: 1800 }] },
];

function buildSnapshot(def: SceneDef) {
  // 两个场景结构不同：原语种类组合、轨迹方向、颜色、时长均不同 → 内容摘要必然不同。
  const rotationFlip = def.sceneId === "workcell-a" ? 1 : -1;
  return {
    schemaVersion: 1, id: def.sceneId, projectId: "opponent", name: `Native opponent ${def.sceneId}`,
    primitives: def.sceneId === "workcell-a"
      ? [
          { modelId: "pump", name: "Pump", kind: "box", color: "#c96f4a", visible: true, opacity: 1, transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { modelId: "valve", name: "Valve", kind: "cylinder", color: "#4a9ac9", visible: true, opacity: 1, transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
        ]
      : [
          { modelId: "slide", name: "Slide", kind: "cylinder", color: "#5bc96f", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: -2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { modelId: "gantry", name: "Gantry", kind: "box", color: "#c9a24a", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
        ],
    models: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 4, z: 10 }, target: { x: 0, y: 0, z: 0 } },
    environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
    createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z",
    animation: { duration: def.durationSeconds, loop: true, camera: [], models: def.sceneId === "workcell-a"
      ? [
          { id: "pump-0", time: 0, modelId: "pump", transform: { position: { x: -2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { id: "pump-1", time: 1, modelId: "pump", transform: { position: { x: 3, y: 1, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } } },
          { id: "valve-0", time: 0, modelId: "valve", transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { id: "valve-1", time: 1, modelId: "valve", transform: { position: { x: 2, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.5, y: 2, z: 0.5 } } },
        ]
      : [
          { id: "slide-0", time: 0, modelId: "slide", transform: { position: { x: 0, y: 0, z: -2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { id: "slide-1", time: 2, modelId: "slide", transform: { position: { x: -3, y: 2, z: -2 }, rotation: { x: 0, y: rotationFlip * Math.PI, z: 0 }, scale: { x: 0.75, y: 0.75, z: 2 } } },
          { id: "gantry-0", time: 0, modelId: "gantry", transform: { position: { x: 0, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
          { id: "gantry-1", time: 2, modelId: "gantry", transform: { position: { x: 1, y: 0.5, z: 2 }, rotation: { x: rotationFlip * Math.PI / 3, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 1 } } },
        ] },
  };
}

const executable = process.env.DEEP_DYNAMIC_EXE ?? path.join(repo, "packages/deep-engine-native/target/debug/deep-engine-native.exe");
const executableSha256 = sha(await readFile(executable));
const runs: Array<{ sceneId: string; round: number; exitCode: number; frameDigestSha256: string; packageHash: string; presentations: number }> = [];
const digestsByScene = new Map<string, string[]>();

for (const def of scenes) {
  const sceneOutput = path.join(output, def.sceneId);
  await mkdir(sceneOutput, { recursive: true });
  const compiled = await compiler.compileSceneRuntimePackage(buildSnapshot(def), { packageId: def.packageId, packageVersion: "1.0.0", loadModel: async () => { throw new Error("scene must stay primitive-only"); } });
  const parsedPackage = JSON.parse(compiled.packageJson);
  const dynamicPayload = parsedPackage.payloads[parsedPackage.entrypoints.dynamicRuntime];
  const rebuilt = structuredClone(parsedPackage);
  rebuilt.payloads["scene.dynamic"] = { ...dynamicPayload,
    dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "telemetry", events: def.events.map((event) => ({ ...event, payload: { value: event.revision * 11 } })) },
    interaction: { schema: "deep-engine.dynamic-interaction", schemaVersion: 1, trigger: "command", action: "select", targetId: def.sceneId === "workcell-a" ? "pump" : "slide" },
  };
  const dynamicResource = rebuilt.resources.find((resource: { kind: string }) => resource.kind === "dynamic-runtime");
  dynamicResource.contentHash.value = compiler.runtimeContentSha256(rebuilt.payloads["scene.dynamic"]);
  rebuilt.packageHash.value = compiler.runtimePackageSha256(rebuilt);
  const frozen = compiler.parseDeepRuntimePackage(JSON.stringify(rebuilt));
  assert.equal(frozen.valid, true);
  const frozenFile = path.join(sceneOutput, "frozen.runtime.json");
  await writeFile(frozenFile, compiler.serializeDeepRuntimePackage(frozen.value));

  const digests: string[] = [];
  for (let round = 1; round <= 2; round += 1) {
    const result = spawnSync(executable, ["--smoke-dynamic-package", frozenFile], { cwd: sceneOutput, encoding: "utf8", windowsHide: true, timeout: 180_000 });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    assert.equal(result.status, 0, text);
    const line = text.split("\n").find((candidate) => candidate.startsWith("native dynamic playback receipt: "));
    assert.ok(line, `missing receipt: ${text}`);
    const receipt = JSON.parse(line.slice("native dynamic playback receipt: ".length));
    assert.equal(receipt.packageHash, frozen.value.packageHash.value);
    assert.equal(receipt.clock, "real-window");
    const digest = sha(Buffer.from(JSON.stringify(receipt.steps)));
    digests.push(digest);
    runs.push({ sceneId: def.sceneId, round, exitCode: result.status ?? 1, frameDigestSha256: digest, packageHash: frozen.value.packageHash.value, presentations: receipt.presentations.length });
  }
  assert.equal(digests[0], digests[1], `${def.sceneId}: native rounds must be digest-identical`);
  digestsByScene.set(def.sceneId, digests);
}
assert.notEqual(digestsByScene.get("workcell-a")![0], digestsByScene.get("workcell-b")![0], "scenes must be independent (different digests)");

const evidence = {
  schema: "deep-engine.d24-d28-native-opponent.v1",
  generatedAt: new Date().toISOString(),
  executable: { path: executable, sha256: executableSha256 },
  scenes: scenes.map((def) => def.sceneId),
  runs,
  checks: {
    roundsRepeatable: [...digestsByScene.values()].every((digests) => digests[0] === digests[1]),
    scenesIndependent: digestsByScene.get("workcell-a")![0] !== digestsByScene.get("workcell-b")![0],
    allExitZero: runs.every((run) => run.exitCode === 0),
  },
  evidenceBoundary: "Native 真窗口对手运行的确定性证据；不含 Web 端与视觉验收",
};
await writeFile(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ scenes: evidence.scenes, runs: runs.length, checks: evidence.checks }, null, 2));
