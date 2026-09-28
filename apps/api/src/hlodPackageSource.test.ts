import { describe, expect, it } from "vitest";
import { buildHlodTree, decideHlodFrame, generateClusterProxyGeometry } from "@bim-studio/deep-engine/hlod";
import {
  buildHlodPackage,
  hlodProxyDrawList,
  hlodReferenceCamera,
  hlodSceneSphere,
  HLOD_PACKAGE_REFERENCE_TIER_SCALES,
  mergeHlodProxyGeometries,
} from "./hlodPackageSource.js";
import { hlodTreeFromManifest } from "./hlodPackageManifest.js";
import { HLOD_PACKAGE_SCHEMA, HLOD_PACKAGE_VERSION, HLOD_PROXY_GEOMETRY_PREFIX,
  type HlodPackageBuildResult, type HlodPackageInstanceInput } from "./hlodPackageTypes.js";

/** 合成场景:边长 SPACING 的 GRID×GRID×GRID 网格,每格一个 2m 立方体实例(纯平移)。 */
const GRID = 4, SPACING = 10;

function gridInputs(grid = GRID): HlodPackageInstanceInput[] {
  const inputs: HlodPackageInstanceInput[] = [];
  for (let x = 0; x < grid; x++) for (let y = 0; y < grid; y++) for (let z = 0; z < grid; z++) {
    const cx = x * SPACING, cy = y * SPACING, cz = z * SPACING;
    inputs.push({
      instanceId: `i${x}_${y}_${z}`,
      sphereCenter: [cx + 1, cy + 1, cz + 1],
      sphereRadius: Math.hypot(2, 2, 2) * 0.5,
      min: [cx, cy, cz],
      max: [cx + 2, cy + 2, cz + 2],
      triangles: 12,
    });
  }
  return inputs;
}

const build = (inputs = gridInputs(), options = {}): HlodPackageBuildResult => buildHlodPackage(inputs, options);

describe("T26 hlodPackage core build (renderPacket wiring slice)", () => {
  it("emits a schema-valid manifest with per-level proxy tiers and count invariants", () => {
    const { manifest, geometries } = build();
    expect(manifest.schema).toBe(HLOD_PACKAGE_SCHEMA);
    expect(manifest.version).toBe(HLOD_PACKAGE_VERSION);
    expect(manifest.clusterAlgorithmVersion).toBe("t26-hlod-cluster-v1");
    expect(manifest.proxyAlgorithmVersion).toBe("t26-hlod-proxy-v1");
    expect(manifest.decision).toEqual({ targetPixelError: 8, hysteresisRatio: 0.12 });
    expect(manifest.instanceCount).toBe(GRID ** 3);
    expect(manifest.stats.leafCount).toBe(GRID ** 3);
    expect(manifest.nodes.map(node => node.id)).toEqual([...manifest.nodes.map(node => node.id)].sort());
    expect(manifest.proxies.map(proxy => proxy.nodeId)).toEqual([...manifest.proxies.map(proxy => proxy.nodeId)].sort());
    // 64 叶 + 8 个 L1 簇 + 1 根:全部内节点都有预生成代理(决策完备)。
    expect(manifest.stats).toEqual({ nodeCount: 73, leafCount: 64, internalCount: 9, depth: 2, maxFanout: 8 });
    expect(manifest.proxies).toHaveLength(9);
    expect(manifest.levels.map(level => level.level)).toEqual([1, 2]);
    expect(manifest.levels[0]).toEqual({ level: 1, proxyCount: 8, proxyTriangleCount: 8 * 96, coveredInstances: 64 });
    expect(manifest.levels[1]).toEqual({ level: 2, proxyCount: 1, proxyTriangleCount: 96, coveredInstances: 64 });
    expect(manifest.proxyTriangleCount).toBe(9 * 96);
    expect(manifest.sourceTriangleCount).toBe(GRID ** 3 * 12);
    expect(geometries).toHaveLength(manifest.proxies.length);
    for (const geometry of geometries) {
      expect(geometry.id.startsWith(HLOD_PROXY_GEOMETRY_PREFIX)).toBe(true);
      expect(geometry.revision).toBe(0);
      expect(geometry.vertices.length % (24 * 6)).toBe(0);
      expect(geometry.indices.length).toBe(geometry.vertices.length / 6 / 4 * 6);
    }
  });

  it("is deterministic: two builds agree bit-for-bit (manifest bytes + geometry buffers)", () => {
    const first = build();
    const second = build();
    expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
    expect(first.geometries.map(geometry => geometry.id)).toEqual(second.geometries.map(geometry => geometry.id));
    for (const [index, geometry] of first.geometries.entries()) {
      expect(Buffer.from(geometry.vertices.buffer, geometry.vertices.byteOffset, geometry.vertices.byteLength).equals(
        Buffer.from(second.geometries[index]!.vertices.buffer, second.geometries[index]!.vertices.byteOffset,
          second.geometries[index]!.vertices.byteLength))).toBe(true);
      expect(Buffer.from(geometry.indices.buffer, geometry.indices.byteOffset, geometry.indices.byteLength).equals(
        Buffer.from(second.geometries[index]!.indices.buffer, second.geometries[index]!.indices.byteOffset,
          second.geometries[index]!.indices.byteLength))).toBe(true);
    }
  });

  it("wires proxy meshes with zero conversion: bytes equal generateClusterProxyGeometry output", () => {
    const inputs = gridInputs();
    const { manifest, geometries } = build(inputs);
    const tree = buildHlodTree(inputs.map(instance => ({
      id: instance.instanceId, position: instance.sphereCenter, radius: instance.sphereRadius })));
    const geometryById = new Map(geometries.map(geometry => [geometry.id, geometry]));
    for (const proxy of manifest.proxies) {
      const node = tree.nodes.get(proxy.nodeId)!;
      const independent = generateClusterProxyGeometry(
        node.instanceIds.map(instanceId => {
          const input = inputs.find(candidate => candidate.instanceId === instanceId)!;
          return { instanceId, min: input.min, max: input.max };
        }), { maxProxyTriangles: manifest.proxyTriangleBudget });
      expect(proxy.geometryId.startsWith(HLOD_PROXY_GEOMETRY_PREFIX)).toBe(true);
      expect(geometryById.get(proxy.geometryId)!.vertices).toEqual(independent.mesh.vertices);
      expect(geometryById.get(proxy.geometryId)!.indices).toEqual(independent.mesh.indices);
      expect(geometryById.get(proxy.geometryId)!.vertices).toBeInstanceOf(Float32Array);
    }
  });

  it("records reference tier evidence from the canonical camera convention (deterministic function of inputs)", () => {
    const { manifest } = build();
    expect(manifest.tiers.map(tier => tier.scale)).toEqual([...HLOD_PACKAGE_REFERENCE_TIER_SCALES]);
    expect(manifest.tiers[0]).toEqual({ scale: 0.25, collapsedNodes: 0, coveredInstances: 0, proxyTriangleCount: 0 });
    // 64× 拉远:根簇折叠,整场景收缩为单代理。
    expect(manifest.tiers[3]).toEqual({ scale: 64, collapsedNodes: 1, coveredInstances: 64, proxyTriangleCount: 96 });
    const reference = hlodReferenceCamera(hlodSceneSphere(gridInputs()), 64);
    expect(reference.viewportHeightPixels).toBe(540);
    expect(Math.hypot(...reference.forward)).toBeCloseTo(1, 12);
  });

  it("maps a client decision onto baked proxies and fails closed when a cluster has no proxy", () => {
    const inputs = gridInputs();
    const result = build(inputs);
    const tree = hlodTreeFromManifest(result.manifest);
    const frame = decideHlodFrame(tree, hlodReferenceCamera(result.manifest.sceneSphere, 64),
      result.manifest.decision);
    const drawList = hlodProxyDrawList(result, frame);
    expect(drawList.draws).toHaveLength(1);
    expect(drawList.hiddenInstances).toBe(64);
    expect(drawList.renderedInstanceIds).toHaveLength(0);
    // 64× 折叠的是根簇:绘制数据源 = 根簇的包内代理。
    expect(drawList.draws[0]!.nodeId).toBe(result.manifest.rootId);
    expect(drawList.draws[0]!.geometryId)
      .toBe(result.manifest.proxies.find(proxy => proxy.nodeId === result.manifest.rootId)!.geometryId);
    const nearFrame = decideHlodFrame(tree, hlodReferenceCamera(result.manifest.sceneSphere, 0.01),
      result.manifest.decision);
    expect(hlodProxyDrawList(result, nearFrame).draws).toHaveLength(0);
    const forgedFrame = decideHlodFrame(tree, hlodReferenceCamera(result.manifest.sceneSphere, 64),
      result.manifest.decision);
    const stripped = { ...result, manifest: { ...result.manifest, proxies: [] } } as HlodPackageBuildResult;
    expect(() => hlodProxyDrawList(stripped, forgedFrame)).toThrow(/no baked proxy/);
  });

  it("guards reserved proxy geometry ids against collisions with existing packet geometries", () => {
    const result = build();
    const proxyId = result.manifest.proxies[0]!.geometryId;
    expect(() => mergeHlodProxyGeometries([proxyId], result)).toThrow(/collides/);
    expect(mergeHlodProxyGeometries([], result)).toEqual(result.geometries);
    // 参考档 scale 非法 fail-closed(不产出带脏证据的包)。
    expect(() => buildHlodPackage(gridInputs(2), { referenceTierScales: [0, 4] })).toThrow(/scale/);
  });

  it("fails closed on duplicate ids and malformed instance shapes", () => {
    const inputs = gridInputs(2);
    expect(() => build([inputs[0]!, inputs[0]!])).toThrow(/Duplicate/);
    expect(() => build([{ ...inputs[0]!, min: [3, 0, 0] as const }])).toThrow(/AABB/);
    expect(() => build([{ ...inputs[0]!, triangles: 1.5 }])).toThrow(/triangle/);
    expect(() => build([{ ...inputs[0]!, sphereRadius: -1 }])).toThrow(/sphere/);
    expect(() => buildHlodPackage(gridInputs(), { targetPixelError: -1 })).toThrow(/targetPixelError/);
  });

  it("handles degenerate scenes honestly: empty package and single-leaf scenes carry no fake proxies", () => {
    const empty = buildHlodPackage([], { referenceTierScales: [1, 8] });
    expect(empty.manifest.rootId).toBeNull();
    expect(empty.manifest.proxies).toHaveLength(0);
    expect(empty.manifest.proxyTriangleBudget).toBe(96);
    expect(empty.geometries).toHaveLength(0);
    expect(empty.manifest.tiers.map(tier => tier.collapsedNodes)).toEqual([0, 0]);

    const single = buildHlodPackage([{
      instanceId: "solo", sphereCenter: [0, 0, 0], sphereRadius: 1,
      min: [-1, -1, -1], max: [1, 1, 1], triangles: 2,
    }], { referenceTierScales: [64] });
    // 单实例 = 叶根:没有任何内节点,不伪造代理;决策叶恒渲染实例。
    expect(single.manifest.proxies).toHaveLength(0);
    expect(single.manifest.stats.leafCount).toBe(1);
    const singleTree = hlodTreeFromManifest(single.manifest);
    const singleFrame = decideHlodFrame(singleTree, hlodReferenceCamera(single.manifest.sceneSphere, 64),
      single.manifest.decision);
    expect(singleFrame.renderedInstances).toBe(1);
    expect(hlodProxyDrawList(single, singleFrame).draws).toHaveLength(0);

    // 预算选项为空场景也如实记录(不经代理条目反推)。
    const budgeted = buildHlodPackage([], { maxProxyTriangles: 24 });
    expect(budgeted.manifest.proxyTriangleBudget).toBe(24);
  });
});
