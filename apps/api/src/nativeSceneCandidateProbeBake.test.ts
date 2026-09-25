import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { gzipSync, gunzipSync } from "node:zlib";
import { createNativeSceneCandidateCompiler } from "./nativeSceneCandidateCompiler.js";
// 直接复用 web 侧会话键函数（编译器 bundle 与服务端注入用的是同一实现）：
// 服务端不重复实现投影逻辑，测试同样以它为唯一哈希事实来源。
import { probeGridBakeSourceHash } from "../../../apps/web/src/delivery/probeGridBakePublicationSession";

let compileNativeSceneCandidate: ReturnType<typeof createNativeSceneCandidateCompiler>;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "api-probe-bake-compiler-"));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../../scripts/build-native-scene-compiler.mjs", import.meta.url)), "--output", directory]);
  compileNativeSceneCandidate = createNativeSceneCandidateCompiler(pathToFileURL(directory + path.sep));
}, 60_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "probe-scene", projectId: "default", name: "探针场景",
    models: [], primitives: [], measurements: [],
    environment: { gridVisible: false, backgroundColor: "#101418", skybox: "none" } as SceneSnapshot["environment"],
    camera: { mode: "orbit", position: { x: 1e9, y: 5, z: 10 }, target: { x: 1e9, y: 0, z: 0 } },
    createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" } as SceneSnapshot;
}
function bake(probeCount: number) {
  return { origin: [0, 0, 0], spacing: 4, gridSize: [4, 4, 4],
    probes: Array.from({ length: probeCount }, () => ({ irradiance: [1, 2, 3], validity: 1, meanDistance: 0, distanceVariance: 0 })) };
}
function gzipDocument(sourceHash: string, probeCount: number): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ sourceHash, bake: bake(probeCount), probeCount, bakedAt: "2026-09-25T00:00:00Z" }), "utf8")));
}

it("服务端候选编译：持久化候选按当前场景语义哈希命中，探针随环境载荷进入运行包", async () => {
  const input = { scene: scene(), models: new Map<string, Uint8Array>(), packageId: "api.probe", packageVersion: "1.0.0" };
  const matched = probeGridBakeSourceHash(input.scene);
  // 两份候选并存：命中的 64 探针 + 一份键不同的干扰候选（只解压命中那份，干扰不注入）。
  const candidates = [
    { sourceHash: matched, gzip: gzipDocument(matched, 64) },
    { sourceHash: "b".repeat(64), gzip: gzipDocument("b".repeat(64), 999) },
  ];
  const result = await compileNativeSceneCandidate({ ...input, probeBakeCandidates: candidates });
  expect(result.evidence.compiledSceneFields).toContainEqual({ field: "irradianceProbes", capability: "deep.scene.probe-grid.v1", resourceId: "scene.environment" });
  const parsed = JSON.parse(result.packageJson) as { payloads: Record<string, { irradianceProbes?: { probes: unknown[] } }> };
  expect(parsed.payloads["scene.environment"]?.irradianceProbes?.probes).toHaveLength(64);
});

it("服务端候选编译：语义哈希失配（场景已变化）即不带探针，包语义与历史一致", async () => {
  const input = { scene: scene(), models: new Map<string, Uint8Array>(), packageId: "api.probe", packageVersion: "1.0.0" };
  // 只持久化了"旧语义"的烘焙：键与当前场景哈希不同。
  const candidates = [{ sourceHash: "b".repeat(64), gzip: gzipDocument("b".repeat(64), 999) }];
  const result = await compileNativeSceneCandidate({ ...input, probeBakeCandidates: candidates });
  expect(result.evidence.compiledSceneFields.some(item => item.field === "irradianceProbes")).toBe(false);
  expect(result.packageJson).not.toContain("irradianceProbes");
  // 失配场景下产物与"无候选"路径逐位一致（同输入同哈希）。
  const baseline = await compileNativeSceneCandidate({ ...input, probeBakeCandidates: [] });
  expect(createHash("sha256").update(result.packageJson).digest("hex"))
    .toBe(createHash("sha256").update(baseline.packageJson).digest("hex"));
});
