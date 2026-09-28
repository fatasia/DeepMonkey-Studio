import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeHlodProxyGeometries, encodeHlodProxyGeometries, decideHlodFrame } from "@bim-studio/deep-engine/hlod";
import { hlodTreeFromManifest, parseHlodPackageManifest, serializeHlodPackageManifest } from "./hlodPackageManifest.js";
import { buildHlodPackage, hlodProxyDrawList, hlodReferenceCamera } from "./hlodPackageSource.js";
import { HLOD_PROXY_GEOMETRY_PREFIX, type HlodPackageInstanceInput } from "./hlodPackageTypes.js";
import { workshopCameraAt, workshopHlodFixture, workshopSceneSphere, type WorkshopHlodFixture } from
  "../../../packages/deep-engine/src/hlod/hlodWorkshopFixture.testUtils.js";

/**
 * T26 renderPacket 接线端到端(CPU 级):车间 GLB 包围(真实 accessor)→ 包
 * (全内节点代理,按树层级档)→ manifest 解析 → 客户端零重聚类决策(远档)→
 * 绘制列表消费包内代理而非 10k 实例。GPU 画面切换留联测(诚实条款)。
 * 期望值锚定第二切片统计:10k 远 4× = 242 代理 / 23,136 代理三角形 / 98.32% 削减。
 */

const TIERS = [1_000, 10_000] as const;
const CAMERAS = [["近 0.25×", 0.25], ["巡航 1×", 1], ["远 4×", 4], ["航拍 64×", 64]] as const;

/** 夹具(球 + 世界盒 + 三角形表)→ 核心构建入参(同源同形约定)。 */
async function workshopInputs(count: (typeof TIERS)[number]) {
  const fixture = await workshopHlodFixture(count);
  const shapeByInstance = new Map(fixture.shapes.map(shape => [shape.instanceId, shape]));
  const inputs: HlodPackageInstanceInput[] = fixture.instances.map(instance => {
    const shape = shapeByInstance.get(instance.id)!;
    return {
      instanceId: instance.id,
      sphereCenter: instance.position,
      sphereRadius: instance.radius,
      min: shape.min,
      max: shape.max,
      triangles: fixture.trianglesByInstance.get(instance.id)!,
    };
  });
  return { fixture, inputs };
}

describe("T26 renderPacket wiring end-to-end on the T00 workshop", () => {
  it("ships a package whose client-side far-tier decision draws 242 baked proxies instead of 10,000 instances",
    async () => {
      const { fixture, inputs } = await workshopInputs(10_000);
      const startedAt = performance.now();
      const result = buildHlodPackage(inputs);
      const buildMs = performance.now() - startedAt;
      const binary = encodeHlodProxyGeometries(result.geometries);
      const decodeStart = performance.now();
      const decoded = decodeHlodProxyGeometries(binary);
      const decodeMs = performance.now() - decodeStart;
      expect(decoded).toHaveLength(result.geometries.length);
      expect(decoded.map(geometry => geometry.id).sort()).toEqual(result.geometries.map(geometry => geometry.id).sort());
      expect(decoded.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0))
        .toBe(result.manifest.proxyTriangleCount);
      console.info(JSON.stringify({ fixture: "T00-10k", instances: inputs.length,
        sourceTriangles: result.manifest.sourceTriangleCount,
        proxyCount: decoded.length,
        binaryBytes: binary.byteLength,
        gzipBinaryBytes: gzipSync(binary).byteLength,
        decodeMs: Number(decodeMs.toFixed(2)),
        buildMs: Number(buildMs.toFixed(2)) }));

      // 包面:manifest 经序列化往返(包存储路径)仍可解析、决策完备。
      const manifest = parseHlodPackageManifest(JSON.parse(serializeHlodPackageManifest(result.manifest)));
      expect(manifest.instanceCount).toBe(10_000);
      expect(manifest.proxies.length).toBe(manifest.stats.internalCount);
      expect(manifest.proxyTriangleCount)
        .toBe(manifest.proxies.reduce((sum, proxy) => sum + proxy.triangleCount, 0));

      // 客户端面:manifest → 决策树(零重聚类)→ 远档决策 → 绘制列表。
      const reconstructed = hlodTreeFromManifest(manifest);
      const camera = hlodReferenceCamera(manifest.sceneSphere, 4);
      const frame = decideHlodFrame(reconstructed, camera, manifest.decision);
      const drawList = hlodProxyDrawList(result, frame);

      // 锚定第二切片:远 4× = 0 实例 / 242 代理 / 23,136 代理三角形。
      expect(frame.renderedInstances).toBe(0);
      expect(frame.hiddenInstances).toBe(10_000);
      expect(drawList.draws).toHaveLength(242);
      expect(drawList.draws.reduce((sum, draw) => sum + draw.instanceCount, 0)).toBe(10_000);
      expect(drawList.draws.reduce((sum, draw) => sum + draw.triangleCount, 0)).toBe(23_136);

      // 绘制数据源 = 包内代理几何(内容寻址 id;零转换字节同源)。
      const geometryById = new Map(result.geometries.map(geometry => [geometry.id, geometry]));
      for (const draw of drawList.draws) {
        const geometry = geometryById.get(draw.geometryId);
        expect(geometry, `missing baked proxy geometry ${draw.geometryId}`).toBeDefined();
        expect(draw.geometryId.startsWith(HLOD_PROXY_GEOMETRY_PREFIX)).toBe(true);
        expect(geometry!.vertices.length).toBe(geometryById.get(draw.geometryId)!.indices.length / 36 * 24 * 6);
      }
      // 包内参考档证据与客户端决策同源同数(包侧可复算,互证)。
      const farTier = manifest.tiers.find(tier => tier.scale === 4)!;
      expect(farTier).toEqual({ scale: 4, collapsedNodes: 242, coveredInstances: 10_000, proxyTriangleCount: 23_136 });

      const reduction = 1 - farTier.proxyTriangleCount / manifest.sourceTriangleCount;
      expect((reduction * 100).toFixed(2)).toBe("98.32");
      expect(manifest.sourceTriangleCount).toBe(1_373_760);
      expect(buildMs).toBeLessThan(30_000);

      // 包内夹具三角源(同第二切片口径):实例球与包输入一一对应。
      expect(fixture.instances).toHaveLength(inputs.length);
      const workshopSphere = workshopSceneSphere(fixture.instances);
      expect(manifest.sceneSphere.extent).toBeCloseTo(workshopSphere.extent, 9);
      expect(workshopCameraAt(workshopSphere, 4).position[0]).toBeCloseTo(camera.position[0], 9);
    });

  it("reproduces the four-camera decision ladder from the package manifest alone", async () => {
    const { inputs } = await workshopInputs(1_000);
    const result = buildHlodPackage(inputs);
    const manifest = parseHlodPackageManifest(JSON.parse(JSON.stringify(result.manifest)));
    const reconstructed = hlodTreeFromManifest(manifest);
    const expected: Record<number, { collapsedNodes: number; coveredInstances: number; proxyTriangleCount: number }> = {
      0.25: { collapsedNodes: 0, coveredInstances: 0, proxyTriangleCount: 0 },
      1: { collapsedNodes: 0, coveredInstances: 0, proxyTriangleCount: 0 },
      4: { collapsedNodes: 205, coveredInstances: 781, proxyTriangleCount: 9_372 },
      64: { collapsedNodes: 1, coveredInstances: 1_000, proxyTriangleCount: 96 },
    };
    const rows: string[] = [];
    for (const [label, scale] of CAMERAS) {
      const frame = decideHlodFrame(reconstructed, hlodReferenceCamera(manifest.sceneSphere, scale), manifest.decision);
      const drawList = hlodProxyDrawList(result, frame);
      const drawTriangles = drawList.draws.reduce((sum, draw) => sum + draw.triangleCount, 0);
      expect(drawList.draws.length).toBe(expected[scale]!.collapsedNodes);
      expect(frame.hiddenInstances).toBe(expected[scale]!.coveredInstances);
      expect(drawTriangles).toBe(expected[scale]!.proxyTriangleCount);
      // 隐藏数随距离单调不减(语义不变式)。
      rows.push(`1k ${label} 渲染 ${frame.renderedInstances} 隐藏 ${frame.hiddenInstances} 代理 ${drawList.draws.length}`);
    }
    expect(rows).toHaveLength(4);
  });
});
