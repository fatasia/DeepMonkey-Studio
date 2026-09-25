import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProbeGridBakeCandidates, loadProbeGridBakeDocument, MAX_BAKES_PER_SCENE,
  normalizeProbeGridBakeDocument, probeGridBakeDirectoryForTest, storeProbeGridBakeDocument } from "./probeGridBakeStore.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

const hashA = "a".repeat(64), hashB = "b".repeat(64);
function document(sourceHash = hashA, probeCount = 8) {
  return { sourceHash, probeCount, coveredCount: probeCount, bakedAt: "2026-09-25T00:00:00Z",
    bake: { origin: [0, 0, 0], spacing: 4, gridSize: [2, 2, 2],
      probes: Array.from({ length: probeCount }, () => ({ irradiance: [1, 2, 3], validity: 1, meanDistance: 0, distanceVariance: 0 })) } };
}

describe("probeGridBakeStore（内容寻址 gzip 落盘）", () => {
  it("保存后按 (sceneId, sourceHash) 读取回原文档；落盘为 gzip 压缩字节", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "probe-bake-store-"));
    directories.push(dataDir);
    const stored = await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-1", document: document() });
    expect(stored.bytes).toBeGreaterThan(0);
    expect(stored.compressedBytes).toBeLessThan(stored.bytes);
    // 文件字节即 gzip 流（magic 0x1f 0x8b），不是明文 JSON——压缩落盘合同。
    const raw = await readFile(path.join(probeGridBakeDirectoryForTest(dataDir, "scene-1"), `${hashA}.json.gz`));
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(raw).toString("utf8")).toContain(`"sourceHash":"${hashA}"`);
    const loaded = await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash: hashA });
    expect(loaded).toEqual(document());
  });

  it("同 hash 重复写入幂等（目录仍一份，内容为最后一次）；hash 非法即拒绝", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "probe-bake-store-"));
    directories.push(dataDir);
    await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-1", document: document(hashA, 8) });
    await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-1", document: document(hashA, 27) });
    const files = await readdir(probeGridBakeDirectoryForTest(dataDir, "scene-1"));
    expect(files.filter(name => name.endsWith(".json.gz"))).toEqual([`${hashA}.json.gz`]);
    expect((await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash: hashA }))?.probeCount).toBe(27);
    await expect(loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash: "zz" })).rejects.toThrow(/sourceHash/);
  });

  it("未命中返回 undefined（404 语义），跨场景键隔离", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "probe-bake-store-"));
    directories.push(dataDir);
    await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-1", document: document() });
    expect(await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash: hashB })).toBeUndefined();
    expect(await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-2", sourceHash: hashA })).toBeUndefined();
  });

  it("每场景按 mtime 保留最近 MAX_BAKES_PER_SCENE 份，超出淘汰最旧", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "probe-bake-store-"));
    directories.push(dataDir);
    const hashes = Array.from({ length: MAX_BAKES_PER_SCENE + 2 }, (_, index) => `${index}`.repeat(64));
    for (const [index, sourceHash] of hashes.entries()) {
      await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-1", document: document(sourceHash, index + 1) });
      // 保证 mtime 单调递增（同毫秒内写入时排序不稳定）。
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const files = (await readdir(probeGridBakeDirectoryForTest(dataDir, "scene-1"))).filter(name => name.endsWith(".json.gz"));
    expect(files).toHaveLength(MAX_BAKES_PER_SCENE);
    // 最早两份被淘汰；最新 MAX 份保留且可读。
    expect(await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash: hashes[0]! })).toBeUndefined();
    expect(await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash: hashes[1]! })).toBeUndefined();
    for (const sourceHash of hashes.slice(2)) {
      expect(await loadProbeGridBakeDocument({ dataDir, sceneId: "scene-1", sourceHash })).toBeDefined();
    }
  });

  it("候选编译链透传：列出 gzip 原始字节与键；空目录/缺目录返回空数组", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "probe-bake-store-"));
    directories.push(dataDir);
    expect(await listProbeGridBakeCandidates({ dataDir, sceneId: "scene-x" })).toEqual([]);
    await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-x", document: document(hashA) });
    await storeProbeGridBakeDocument({ dataDir, sceneId: "scene-x", document: document(hashB) });
    const candidates = await listProbeGridBakeCandidates({ dataDir, sceneId: "scene-x" });
    expect(candidates.map(item => item.sourceHash).sort()).toEqual([hashA, hashB]);
    for (const candidate of candidates) {
      const parsed = JSON.parse(gunzipSync(Buffer.from(candidate.gzip)).toString("utf8")) as { sourceHash: string };
      expect(parsed.sourceHash).toBe(candidate.sourceHash);
    }
  });

  it("normalizeProbeGridBakeDocument：格式/大小校验（413）与可选字段规范化", () => {
    expect(() => normalizeProbeGridBakeDocument(null, 1024)).toThrow(/格式无效/);
    expect(() => normalizeProbeGridBakeDocument({ sourceHash: hashA }, 1024)).toThrow(/JSON 对象/);
    expect(() => normalizeProbeGridBakeDocument({ sourceHash: "nothex", bake: {} }, 1024)).toThrow(/sourceHash/);
    const normalized = normalizeProbeGridBakeDocument({ sourceHash: hashA, bake: { probes: [] }, bakedAt: "t" }, 1024);
    expect(normalized).toEqual({ sourceHash: hashA, bake: { probes: [] }, bakedAt: "t" });
    expect(() => normalizeProbeGridBakeDocument(document(hashA, 8), 64)).toThrow(/字节上限/);
    try {
      normalizeProbeGridBakeDocument(document(hashA, 8), 64);
      expect.fail("应拒绝超限文档");
    } catch (reason) {
      expect((reason as { statusCode?: number }).statusCode).toBe(413);
    }
  });
});
