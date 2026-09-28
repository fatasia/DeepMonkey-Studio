import { describe, expect, it } from "vitest";
import { buildHlodTree, decideHlodFrame } from "@bim-studio/deep-engine/hlod";
import { buildHlodPackage, hlodReferenceCamera } from "./hlodPackageSource.js";
import { hlodTreeFromManifest, parseHlodPackageManifest, serializeHlodPackageManifest } from "./hlodPackageManifest.js";
import type { HlodPackageBuildResult, HlodPackageInstanceInput } from "./hlodPackageTypes.js";

/** 合成场景:2×2×2 网格(快),manifest 全字段可断言。 */
function gridInputs(): HlodPackageInstanceInput[] {
  const inputs: HlodPackageInstanceInput[] = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    inputs.push({
      instanceId: `i${x}${y}${z}`,
      sphereCenter: [x * 10 + 1, y * 10 + 1, z * 10 + 1],
      sphereRadius: Math.hypot(3),
      min: [x * 10, y * 10, z * 10],
      max: [x * 10 + 2, y * 10 + 2, z * 10 + 2],
      triangles: 120,
    });
  }
  return inputs;
}

const built = (): HlodPackageBuildResult => buildHlodPackage(gridInputs(), { referenceTierScales: [1, 8] });

describe("T26 hlodPackage manifest schema (parse / serialize / reconstruct)", () => {
  it("round-trips through JSON with canonical bytes", () => {
    const { manifest } = built();
    const serialized = serializeHlodPackageManifest(manifest);
    const parsed = parseHlodPackageManifest(JSON.parse(serialized));
    expect(parsed).toEqual(manifest);
    expect(serializeHlodPackageManifest(parsed)).toBe(serialized);
  });

  it("reconstructs a decision tree whose decisions are bit-identical to the build-side tree", () => {
    const inputs = gridInputs();
    const { manifest } = built();
    const buildSide = buildHlodTree(inputs.map(instance => ({
      id: instance.instanceId, position: instance.sphereCenter, radius: instance.sphereRadius })));
    const clientSide = hlodTreeFromManifest(manifest);
    expect(clientSide.rootId).toBe(buildSide.rootId);
    expect(clientSide.stats).toEqual(buildSide.stats);
    expect([...clientSide.nodes.keys()].sort()).toEqual([...buildSide.nodes.keys()].sort());
    for (const [id, node] of buildSide.nodes) expect(clientSide.nodes.get(id)).toEqual(node);
    for (const scale of [0.5, 2, 16]) {
      const camera = hlodReferenceCamera(manifest.sceneSphere, scale);
      expect(decideHlodFrame(clientSide, camera)).toEqual(decideHlodFrame(buildSide, camera));
    }
  });

  it("rejects unknown fields, broken graphs, drifted stats and malformed cells (fail-closed)", () => {
    const { manifest } = built();
    const clone = () => JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

    const withUnknownField = clone();
    (withUnknownField as Record<string, unknown>).surprise = 1;
    expect(() => parseHlodPackageManifest(withUnknownField)).toThrow(/未知字段/);

    const withNullRoot = clone();
    withNullRoot.rootId = null;
    withNullRoot.nodes = [];
    withNullRoot.stats = { ...manifest.stats, nodeCount: 0, leafCount: 0, internalCount: 0, depth: 0, maxFanout: 0 };
    withNullRoot.proxies = [];
    withNullRoot.levels = [];
    withNullRoot.instanceCount = 0;
    withNullRoot.proxyTriangleCount = 0;
    // 空场景 manifest(全空表 + null 根)是合法状态;这里只验证它可解析。
    expect(parseHlodPackageManifest(withNullRoot).rootId).toBeNull();

    const withNullAndNodes = clone();
    withNullAndNodes.rootId = null;
    expect(() => parseHlodPackageManifest(withNullAndNodes)).toThrow(/rootId/);

    const withBrokenChild = clone();
    (withBrokenChild.nodes as Record<string, unknown>[])[manifest.nodes.length - 1]!.children = ["ghost"];
    expect(() => parseHlodPackageManifest(withBrokenChild)).toThrow(/引用缺失子节点/);

    const withDriftedStats = clone();
    (withDriftedStats.stats as Record<string, unknown>).nodeCount = 99;
    expect(() => parseHlodPackageManifest(withDriftedStats)).toThrow(/stats/);

    const withBadCell = clone();
    (withBadCell.rootCell as Record<string, unknown>).side = 3;
    expect(() => parseHlodPackageManifest(withBadCell)).toThrow(/2 的幂/);

    const withBadBudget = clone();
    withBadBudget.proxyTriangleBudget = 97;
    expect(() => parseHlodPackageManifest(withBadBudget)).toThrow(/12 的倍数/);
  });

  it("rejects proxy records that hang off leaves or violate the triangle budget", () => {
    const { manifest } = built();
    const leaf = manifest.nodes.find(node => node.children.length === 0)!;
    const forged = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    (forged.proxies as Record<string, unknown>[]).push({
      nodeId: leaf.id, level: 0, geometryId: "hlod-proxy-forged",
      instanceCount: leaf.instanceCount, boxCount: 1, triangleCount: 12,
    });
    expect(() => hlodTreeFromManifest(parseHlodPackageManifest(forged))).toThrow(/叶节点/);

    const overBudget = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    (overBudget.proxies as Record<string, unknown>[])[0]!.triangleCount = 999;
    expect(() => parseHlodPackageManifest(overBudget)).toThrow(/三角形预算/);
  });
});
