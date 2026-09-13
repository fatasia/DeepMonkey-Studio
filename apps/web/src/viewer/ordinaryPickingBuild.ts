import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { PickingSnapshot } from "./ordinaryPickingGeometry";

/** Worker 与真实 Three 微基准共用官方建树，不修改源 geometry 的索引或包围盒。 */
export function buildPickingIndex(snapshot: PickingSnapshot) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(snapshot.position, 3));
  if (snapshot.index) geometry.setIndex(new BufferAttribute(snapshot.index, 1));
  geometry.setDrawRange(snapshot.start, snapshot.count);
  // 不按材质组裁掉三角面：单材质 Mesh 会忽略 groups；查询时由原几何解析多材质组。
  const bvh = new MeshBVH(geometry, { indirect: true, targetLeafSize: 20, setBoundingBox: false, verbose: false });
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
  serialized.index = null;
  geometry.dispose();
  return serialized;
}
