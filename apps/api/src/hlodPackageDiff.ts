import type { GeometryResource } from "@bim-studio/deep-engine";
import { HlodError } from "@bim-studio/deep-engine/hlod";
import type {
  HlodPackageBuildResult,
  HlodPackageDiff,
  HlodPackageManifest,
} from "./hlodPackageTypes.js";

/**
 * HLOD 包级 diff(增量一致性面):实例变更 → 代理重生成 → manifest 对比。
 *
 * 机制与第一切片增量失效结论同源:节点 id = 子树内容哈希 ⇒ 只含变更实例的
 * 祖先闭包换 id,其余子树跨版本**同 id 同字节**(代理内容 = 成员摘要集的纯函数)。
 * 因此包 diff 退化为 geometryId 集合差;unchanged 代理的字节一致性由
 * `assertUnchangedGeometryBytes` 显式验证(防哈希碰撞的最终一道闸)。
 * 根胞元重定(实例逃出 2 的幂边界)⇒ 全树换 id,属诚实降级路径而非缺陷。
 */

export function diffHlodPackages(previous: HlodPackageBuildResult,
  next: HlodPackageBuildResult): HlodPackageDiff {
  validateShape(previous.manifest);
  validateShape(next.manifest);
  const previousIds = new Set(previous.manifest.proxies.map(proxy => proxy.geometryId));
  const nextIds = new Set(next.manifest.proxies.map(proxy => proxy.geometryId));
  const addedGeometryIds = [...nextIds].filter(id => !previousIds.has(id)).sort();
  const removedGeometryIds = [...previousIds].filter(id => !nextIds.has(id)).sort();
  return Object.freeze({
    previousProxyCount: previous.manifest.proxies.length,
    nextProxyCount: next.manifest.proxies.length,
    unchangedProxyCount: previousIds.size - removedGeometryIds.length,
    addedGeometryIds: Object.freeze(addedGeometryIds),
    removedGeometryIds: Object.freeze(removedGeometryIds),
    rootCellShifted: !sameCell(previous.manifest.rootCell, next.manifest.rootCell),
  });
}

/** diff 的字节闸:声明 unchanged 的 geometryId 必须两侧顶点/索引逐字节相同。 */
export function assertUnchangedGeometryBytes(previous: HlodPackageBuildResult,
  next: HlodPackageBuildResult): void {
  const previousGeometries = geometryById(previous);
  const nextGeometries = geometryById(next);
  const removed = new Set(diffHlodPackages(previous, next).removedGeometryIds);
  for (const [id, geometry] of previousGeometries) {
    if (removed.has(id)) continue;
    const candidate = nextGeometries.get(id);
    if (!candidate) throw new HlodError("unknown-node", `HLOD geometry ${id} disappeared without a diff record.`);
    if (!sameBytes(geometry.vertices, candidate.vertices) || !sameBytes(geometry.indices, candidate.indices)) {
      throw new HlodError("hash-collision",
        `HLOD geometry ${id} kept its content id but changed bytes (hash collision or contract drift).`);
    }
  }
}

/** 结果 → geometryId 索引(重复 id fail-closed)。 */
export function hlodGeometryById(result: HlodPackageBuildResult): ReadonlyMap<string, GeometryResource> {
  const map = new Map<string, GeometryResource>();
  for (const geometry of result.geometries) {
    if (map.has(geometry.id)) {
      throw new HlodError("duplicate-instance-id", `Duplicate HLOD geometry id in package: ${geometry.id}`);
    }
    map.set(geometry.id, geometry);
  }
  return map;
}

function geometryById(result: HlodPackageBuildResult): ReadonlyMap<string, GeometryResource> {
  return hlodGeometryById(result);
}

function sameCell(left: HlodPackageManifest["rootCell"], right: HlodPackageManifest["rootCell"]): boolean {
  return left.side === right.side
    && left.center.every((value, axis) => value === right.center[axis]);
}

function sameBytes(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftView = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightView = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  for (let index = 0; index < leftView.length; index += 1) {
    if (leftView[index] !== rightView[index]) return false;
  }
  return true;
}

function validateShape(manifest: HlodPackageManifest): void {
  if (!manifest || manifest.schema !== "deep-api.hlod-package") {
    throw new HlodError("invalid-options", "HLOD package diff requires parsed hlod-package manifests.");
  }
}
