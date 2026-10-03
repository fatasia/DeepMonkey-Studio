/**
 * F2/驻留感知 HLOD 冻结场景 GPU 对照 —— Node 侧载荷构建(单一来源,由
 * scripts/f2HlodCullGpuTest.mjs 经 esbuild node bundle 消费;浏览器腿不 import 本文件)。
 *
 * 载荷口径与既有 T26 证据(test-output/deep-core/B4-gpu-draw/batch-benchmark.json)
 * 单一来源:T00 车间 10k 档(hlodWorkshopFixture,真实 GLB accessor 包围)×
 * buildHlodTree({maxChildren:8}) × decideHlodFrame(默认 targetPixelError 8/迟滞 0.12)
 * × 相机阶梯 workshopCameraAt(sphere, {0.25,1,4,64})。
 *
 * 诚实边界:本载荷的"全量实例"腿用真实 GLB 节点包围盒几何(与夹具同源,不是全三角
 * 网格);像素级代理误差以包围盒口径计量,真实网格的内部空隙不在此口径内。
 * 决策在生产 hlod 层完成(decideHlodFrame),浏览器腿消费同一份折叠集,并经生产
 * threeBridge.applyHlodPlanToInstances 生成折叠态实例表(隐藏 1e-6 缩放 + 代理追加)。
 */

import { buildHlodTree, type HlodClusterTree } from "../src/hlod/hlodCluster.js";
import { decideHlodFrame } from "../src/hlod/hlodDecision.js";
import { generateHlodClusterProxies } from "../src/hlod/hlodProxyBatch.js";
import { workshopCameraAt, workshopHlodFixture, workshopSceneSphere } from "../src/hlod/hlodWorkshopFixture.testUtils.js";
import { composeProxyInstanceMatrix, hlodProxyDrawCost,
  hlodProxyUnitBoxGeometry } from "../src/webgpu/hlodProxyDrawBatch.js";
import { F2_CAMERAS, F2_MEMBER_GEOMETRY_KEY, F2_TIER, F2_VIEWPORT_HEIGHT, F2_VIEWPORT_WIDTH,
  type F2CameraPayload, type F2Payload, type F2ProxyEntry } from "./f2HlodCullShared.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function b64F32(values: Float32Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64");
}
function b64U32(values: Uint32Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64");
}

/** 构建真机对照载荷(节点侧;失败 fail-closed,不做任何估算)。 */
export async function buildF2Payload(): Promise<F2Payload> {
  const fixture = await workshopHlodFixture(F2_TIER);
  const tree: HlodClusterTree = buildHlodTree(fixture.instances, { maxChildren: 8 });
  const sphere = workshopSceneSphere(fixture.instances);
  const internalNodes = [...tree.nodes.values()].filter(node => node.children.length > 0)
    .map(node => node.id).sort();
  // 全内节点代理(= 非流送路径 allProxyDraws 的资源闭包;几何 id 内容寻址)。
  const proxyBatch = generateHlodClusterProxies(tree, fixture.shapes, internalNodes);
  const entryByDrawId = new Map(proxyBatch.entries.map(entry => [`px-${entry.nodeId}`, entry]));

  const ids = fixture.instances.map(instance => instance.id);
  const idIndex = new Map(ids.map((id, index) => [id, index]));
  const memberTransforms = new Float32Array(ids.length * 16);
  const triangles = new Uint32Array(ids.length);
  fixture.instances.forEach((instance, index) => {
    const shape = fixture.shapes[index]!;
    if (shape.instanceId !== instance.id) throw new Error(`fixture shape/instance order drifted at ${index}.`);
    const half: [number, number, number] = [(shape.max[0]! - shape.min[0]!) / 2,
      (shape.max[1]! - shape.min[1]!) / 2, (shape.max[2]! - shape.min[2]!) / 2];
    const center: [number, number, number] = [(shape.max[0]! + shape.min[0]!) / 2,
      (shape.max[1]! + shape.min[1]!) / 2, (shape.max[2]! + shape.min[2]!) / 2];
    memberTransforms.set(composeProxyInstanceMatrix(IDENTITY, { center, half }), index * 16);
    triangles[index] = fixture.trianglesByInstance.get(instance.id)!;
  });

  // proxyList 按 drawId 升序 = 生产 allProxyDraws 的确定性遍历序(排序后固定)。
  const proxyList: F2ProxyEntry[] = proxyBatch.entries.map(entry => ({
    drawId: `px-${entry.nodeId}`, geometryId: entry.geometryId, level: entry.level,
    memberCount: entry.instanceCount,
    verticesB64: b64F32(entry.proxy.mesh.vertices),
    indicesB64: b64U32(entry.proxy.mesh.indices),
  })).sort((left, right) => left.drawId < right.drawId ? -1 : left.drawId > right.drawId ? 1 : 0);

  const cameras: F2CameraPayload[] = F2_CAMERAS.map(([label, scale]) => {
    const camera = workshopCameraAt(sphere, scale);
    // 近/远平面按逐相机视距闭合(航拍 64× 视距 ≈2.74·scale·extent,固定 extent×60 会整体裁掉)。
    const eyeDistance = Math.hypot(1.4, 1.5, 1.8) * scale * sphere.extent;
    const cameraNear = Math.max(Math.min(sphere.extent * 0.01, eyeDistance * 0.01), 0.05);
    const cameraFar = eyeDistance + sphere.extent * 3;
    const decision = decideHlodFrame(tree, camera);
    const hiddenIndices: number[] = [];
    for (const node of decision.collapsedNodes) {
      for (const apiId of tree.nodes.get(node.nodeId)?.instanceIds ?? []) {
        const index = idIndex.get(apiId);
        if (index === undefined) throw new Error(`collapsed member ${apiId} missing in fixture.`);
        hiddenIndices.push(index);
      }
    }
    hiddenIndices.sort((left, right) => left - right);
    const activeOrdinals: number[] = [];
    for (const node of decision.collapsedNodes) {
      const drawId = `px-${node.nodeId}`;
      const ordinal = proxyList.findIndex(proxy => proxy.drawId === drawId);
      if (ordinal < 0 || !entryByDrawId.has(drawId)) {
        throw new Error(`collapsed node ${node.nodeId} has no proxy entry.`);
      }
      activeOrdinals.push(ordinal);
    }
    activeOrdinals.sort((left, right) => left - right);
    const proxyGeometryBytes = activeOrdinals.reduce((sum, ordinal) => {
      const drawId = proxyList[ordinal]!.drawId;
      const entry = entryByDrawId.get(drawId)!;
      return sum + entry.proxy.mesh.vertices.byteLength + entry.proxy.mesh.indices.byteLength;
    }, 0);
    const cost = hlodProxyDrawCost(activeOrdinals.length,
      proxyGeometryBytes / Math.max(activeOrdinals.length, 1));
    return {
      label, eye: camera.position, forward: camera.forward,
      tanHalfFovY: camera.tanHalfFovY, near: cameraNear, far: cameraFar,
      hiddenIndicesB64: b64U32(Uint32Array.from(hiddenIndices)),
      activeProxyOrdinalsB64: b64U32(Uint32Array.from(activeOrdinals)),
      collapsedNodeCount: decision.collapsedNodes.length,
      activeProxies: activeOrdinals.length, hiddenInstances: hiddenIndices.length,
      t26: { perProxyDraws: cost.perProxyDraws, batchedDraws: cost.batchedDraws,
        drawReduction: cost.drawReduction ?? 0, proxyGeometryBytes },
    };
  });

  const unit = hlodProxyUnitBoxGeometry();
  return {
    schema: "f2-hlod-cull-payload-v1",
    note: `T00 车间 10k 真实 GLB accessor 包围;决策 decideHlodFrame 默认(targetPixelError 8/迟滞 0.12);`
      + `渲染口 ${F2_VIEWPORT_WIDTH}×${F2_VIEWPORT_HEIGHT};全量腿=真实节点世界 AABB 盒(非全三角网格,如实口径);`
      + `折叠腿=生产 applyHlodPlanToInstances 输出(隐藏 1e-6 缩放 + 代理追加)。`,
    ids,
    memberTransformsB64: b64F32(memberTransforms),
    trianglesB64: b64U32(triangles),
    unitGeometry: { verticesB64: b64F32(unit.vertices), indicesB64: b64U32(unit.indices) },
    proxyList,
    cameras,
    sceneSphere: sphere,
    sourceTriangles: [...fixture.trianglesByInstance.values()].reduce((sum, value) => sum + value, 0),
  };
}
