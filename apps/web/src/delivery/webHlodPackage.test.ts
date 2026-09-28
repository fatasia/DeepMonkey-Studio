import { createHash, webcrypto } from "node:crypto";
import { ASSET_FACETS, type AssetCompatibilityProfile } from "@bim-studio/deep-engine";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DeepAssetPackage, RenderPacket } from "@bim-studio/deep-engine";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { buildHlodTree, decodeHlodProxyGeometries, encodeHlodProxyGeometries, HLOD_PROXY_ALGORITHM_VERSION,
  type HlodPackageManifest } from "@bim-studio/deep-engine/hlod";
import { compileSceneRenderPacket, type SceneRenderCompilation } from "./compileSceneRenderPacket";
import { bindWebHlodAsset, bindWebHlodPackage, decideWebHlodDraws, gltfNodeApiIds, loadWebHlodPackage,
  verifyWebHlodGeometry } from "./webHlodPackage";

const box = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const document = JSON.parse(box.subarray(20, 20 + box.readUInt32LE(12)).toString("utf8"));
  const meshNode = document.nodes.findIndex((node: { mesh?: number }) => node.mesh !== undefined);
  const roots: number[] = document.scenes[0].nodes;
  let path = "";
  const walk = (nodes: number[], prefix = ""): void => {
    for (const [index, node] of nodes.entries()) {
      const current = prefix ? `${prefix}.${index}` : String(index);
      if (node === meshNode) path = current;
      walk(document.nodes[node].children ?? [], current);
    }
  };
  walk(roots);
  const apiId = `node:${path}${document.nodes[meshNode].name ? `:${document.nodes[meshNode].name}` : ""}`;
  return { apiId, meshNode };
}
const source = fixture();
const scene = { schemaVersion: 1 as const, id: "s", projectId: "p", name: "sample",
  camera: { mode: "orbit" as const, position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 } },
  models: [{ modelId: "part", assetModelId: "asset", name: "part", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  primitives: [], measurements: [], createdAt: "", updatedAt: "" };
function minimalManifest(instanceId: string): HlodPackageManifest {
  const tree = buildHlodTree([{ id: instanceId, position: [0, 0, 0], radius: 1 }]);
  const node = [...tree.nodes.values()][0]!;
  return { schema: "deep-api.hlod-package", version: 1, clusterAlgorithmVersion: tree.algorithmVersion,
    proxyAlgorithmVersion: HLOD_PROXY_ALGORITHM_VERSION, decision: { targetPixelError: 8, hysteresisRatio: 0.12 },
    clusterOptions: tree.options, proxyTriangleBudget: 96, rootCell: tree.rootCell,
    rootId: tree.rootId, stats: tree.stats, nodes: [{ ...node, parent: null }], levels: [], proxies: [], tiers: [],
    sceneSphere: { center: [0, 0, 0], extent: 1 }, instanceCount: 1, sourceTriangleCount: 12, proxyTriangleCount: 0 };
}

describe("Web HLOD optional package consumer", () => {
  it("maps original GLB node path to Web primitive ID without polluting author bindings", async () => {
    const compiled = await compileSceneRenderPacket(scene, { loadModel: async () => box });
    const before = JSON.stringify(compiled.packet.objectBindings);
    const manifest = minimalManifest(source.apiId);
    const bound = bindWebHlodPackage(box, compiled.packet, manifest, "part", "asset");
    const expected = `model-${runtimeContentSha256("part")}/asset-${runtimeContentSha256("asset")}/node/${source.meshNode}/primitive/0`;
    expect(bound.instanceIdsByNode.get(source.apiId)).toEqual([expected]);
    expect(JSON.stringify(compiled.packet.objectBindings)).toBe(before);
    const decision = decideWebHlodDraws({ manifest, proxies: [], geometryHash: hash(box) }, bound,
      { position: [0, 0, 10], forward: [0, 0, -1], viewportHeightPixels: 1080, tanHalfFovY: 0.5, pixelThreshold: 1 });
    expect(decision.hiddenInstanceIds.size).toBe(0);
    expect(decision.proxyDraws).toEqual([]);
  });

  it("rejects missing source nodes, wrong model binding and altered manifest bytes", async () => {
    const compiled = await compileSceneRenderPacket(scene, { loadModel: async () => box });
    const manifest = minimalManifest("node:missing");
    expect(() => bindWebHlodPackage(box, compiled.packet, manifest, "part", "asset")).toThrow(/不匹配/);
    expect(() => bindWebHlodPackage(box, compiled.packet, minimalManifest(source.apiId), "missing", "asset"))
      .toThrow(/未出现在/);
  });

  it("loads content-addressed manifest and binary through the existing package resource paths", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const manifest = minimalManifest(source.apiId), manifestBytes = Buffer.from(JSON.stringify(manifest));
    const binary = encodeHlodProxyGeometries([]);
    const mh = hash(manifestBytes), ph = hash(binary);
    const packageUrl = "http://localhost/assets/projects/p/models/asset/output/deep-package.json";
    const manifestPath = `output/hlod-manifest-${mh}.json`, proxyPath = `output/hlod-proxies-${ph}.bin`;
    const compatibility: AssetCompatibilityProfile = {
      schemaVersion: 1, id: "fixture-hlod", sourceKind: "model-file", format: "glb",
      importer: "open-converter", runtimeArtifact: "deep-asset-package", importerVersion: "1.0.0",
      fixtureSetHash: "c".repeat(64), deterministic: true,
      facets: Object.fromEntries(ASSET_FACETS.map(facet => [facet,
        { status: "unverified", evidenceIds: [], reason: "样例没有该项独立验收" }])) as unknown as AssetCompatibilityProfile["facets"],
    };
    const sceneBytes = Buffer.from(JSON.stringify({ resources: ["geometry:main", "metadata:hlod-manifest", "mesh:hlod-proxies"] }, null, 2));
    const sh = hash(sceneBytes);
    const pkg: DeepAssetPackage = { schemaVersion: 1, manifest: { schemaVersion: 1, packageId: "pkg:asset",
      source: { kind: "model-file", logicalName: "Box.glb", contentHash: hash(box), byteLength: box.length },
      importer: { kind: "open-converter", id: "fixture", version: "1.0.0", recipeHash: "a".repeat(64), deterministic: true },
      compatibility, resources: [
        { id: "geometry:main", kind: "mesh", logicalPath: "output/geometry.glb", blobHash: hash(box), dependencies: [] },
        { id: "mesh:hlod-proxies", kind: "mesh", logicalPath: proxyPath, blobHash: ph, dependencies: [] },
        { id: "metadata:hlod-manifest", kind: "metadata", logicalPath: manifestPath, blobHash: mh, dependencies: [] },
        { id: "scene:main", kind: "scene", logicalPath: "scene/main.json", blobHash: sh,
          dependencies: ["geometry:main", "mesh:hlod-proxies", "metadata:hlod-manifest"] }], entryScene: "scene:main" },
      blobs: [
        { hash: mh, byteLength: manifestBytes.length, mediaType: "application/json" },
        { hash: ph, byteLength: binary.length, mediaType: "application/octet-stream" },
        { hash: sh, byteLength: sceneBytes.length, mediaType: "application/json" },
        { hash: hash(box), byteLength: box.length, mediaType: "model/gltf-binary" },
      ].sort((a,b) => a.hash.localeCompare(b.hash)),
    };
    const bytes = new Map([[packageUrl, Buffer.from(JSON.stringify({ package: pkg }))],
      [new URL(manifestPath.slice(7), packageUrl).href, manifestBytes],
      [new URL(proxyPath.slice(7), packageUrl).href, binary]]);
    const load = vi.fn(async (url: string) => { const item = bytes.get(url); if (!item) throw new Error(url); return item; });
    const loaded = await loadWebHlodPackage(packageUrl, load, new AbortController().signal);
    expect(loaded).toMatchObject({ manifest: { instanceCount: 1 }, proxies: [], geometryHash: hash(box) });
    await expect(verifyWebHlodGeometry(box, loaded)).resolves.toBeUndefined();
    await expect(verifyWebHlodGeometry(Uint8Array.of(0), loaded)).rejects.toThrow(/内容哈希不一致/);
    expect(load).toHaveBeenCalledTimes(3);
    bytes.set(new URL(proxyPath.slice(7), packageUrl).href, Uint8Array.of(0));
    await expect(loadWebHlodPackage(packageUrl, load, new AbortController().signal)).rejects.toThrow(/哈希不一致/);
    vi.unstubAllGlobals();
  });

  it("编译层 opt-in：glTF 节点可映射 API id，资产级绑定校验叶全集", async () => {
    const result = await compileSceneRenderPacket(scene, { loadModel: async () => box });
    const apiIds = gltfNodeApiIds(box);
    expect(apiIds.size).toBeGreaterThan(0);
    const firstApiId = [...apiIds][0];
    if (!firstApiId) throw new Error("Box.glb 未解析出 mesh 节点 apiId");
    const manifest = minimalManifest(firstApiId[1]);
    // Box.glb 源包：实例 id 带 asset-<hash> 前缀；bindWebHlodAsset 按 /node/<i>/primitive/ 匹配
    const bound = bindWebHlodAsset(box, result.packet, manifest);
    expect(bound.get(firstApiId[1])?.length).toBeGreaterThan(0);
    // 默认路径（无 hlodPackages）不产出簇绑定
    expect(result.hlodClusters).toBeUndefined();
  });

  it("hlodPackages 提供时：代理几何入包、hlodClusters 产出、运行包往返仍校验通过", async () => {
    const apiIds = gltfNodeApiIds(box);
    const firstApiId = [...apiIds][0];
    if (!firstApiId) throw new Error("Box.glb 未解析出 mesh 节点 apiId");
    const manifest = minimalManifest(firstApiId[1]);
    const proxies = decodeHlodProxyGeometries(encodeHlodProxyGeometries([]));
    const compiled = await compileSceneRenderPacket(scene, { loadModel: async () => box,
      hlodPackages: new Map([["asset", { manifest, proxies, geometryHash: hash(box) }]]) });
    expect(compiled.hlodClusters).toHaveLength(1);
    const cluster = compiled.hlodClusters![0]!;
    expect(cluster.assetId).toBe("asset");
    expect(cluster.manifest).toEqual(manifest);
    expect(cluster.instanceIdsByNode.get(firstApiId[1])?.length).toBeGreaterThan(0);
    // 代理几何（空包时无代理）；objectBindings 保持仅作者对象
    expect(compiled.packet.objectBindings?.map(item => item.nodeId)).toEqual(["part"]);
    // 全场景实例仍可被簇映射覆盖（Box 单实例）
    const covered = [...cluster.instanceIdsByNode.values()].flat();
    expect(covered).toEqual(compiled.packet.instances.map(instance => instance.id));
    // 运行包往返（代理几何无 uv 等可选流，校验需接受 hlod 代理几何）
    const runtime = buildDeepRuntimePackage({ packageId: "hlod.scene", packageVersion: "1.0.0",
      renderPacket: { id: "scene", revision: 1, value: compiled.packet } });
    expect(validateDeepRuntimePackage(JSON.parse(JSON.stringify(runtime))).valid).toBe(true);
  });
});
