import { describe, expect, it } from "vitest";
import { buildHlodTree, updateHlodTree, type HlodInstanceInput, type HlodTreeChangeSet } from "@bim-studio/deep-engine/hlod";
import { assertUnchangedGeometryBytes, diffHlodPackages, hlodGeometryById } from "./hlodPackageDiff.js";
import { buildHlodPackage } from "./hlodPackageSource.js";
import type { HlodPackageInstanceInput } from "./hlodPackageTypes.js";
import { workshopHlodFixture, type WorkshopHlodFixture } from "@bim-studio/deep-engine/hlod-testing";

/**
 * T26 接线增量一致性:实例变更 → 代理重生成 → 包 diff 最小。
 * 机制与第一切片失效结论同源:节点 id = 子树内容哈希 ⇒ 只含变更实例的祖先闭包
 * 换 id,其余簇同 id 同字节;根胞元重定是诚实降级路径(全树换 id,非缺陷)。
 */

const TIER = 1_000 as const;
const MOVED_COUNT = 3;
const SMALL_STEP = 0.05;

async function packageInputs(): Promise<{ fixture: WorkshopHlodFixture; inputs: HlodPackageInstanceInput[] }> {
  const fixture = await workshopHlodFixture(TIER);
  return { fixture, inputs: toPackageInputs(fixture) };
}

function toPackageInputs(fixture: WorkshopHlodFixture): HlodPackageInstanceInput[] {
  const shapeByInstance = new Map(fixture.shapes.map(shape => [shape.instanceId, shape]));
  return fixture.instances.map(instance => {
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
}

/** 平移实例:球心/盒同步平移(半径与三角形数不变;placement 语义一致)。 */
function translate(inputs: readonly HlodPackageInstanceInput[], ids: ReadonlySet<string>,
  delta: readonly [number, number, number]): { inputs: HlodPackageInstanceInput[]; moved: HlodInstanceInput[] } {
  const moved: HlodInstanceInput[] = [];
  const next = inputs.map(instance => {
    if (!ids.has(instance.instanceId)) return instance;
    const sphereCenter: [number, number, number] = [
      instance.sphereCenter[0] + delta[0], instance.sphereCenter[1] + delta[1], instance.sphereCenter[2] + delta[2]];
    const min: [number, number, number] = [instance.min[0] + delta[0], instance.min[1] + delta[1], instance.min[2] + delta[2]];
    const max: [number, number, number] = [instance.max[0] + delta[0], instance.max[1] + delta[1], instance.max[2] + delta[2]];
    moved.push({ id: instance.instanceId, position: sphereCenter, radius: instance.sphereRadius });
    return { ...instance, sphereCenter, min, max };
  });
  return { inputs: next, moved };
}

/** 前树/后树中「包含任一移动实例」的内节点 id(= 内容祖先闭包,增量失效定理的预期变更集)。 */
function changedProxyNodeIds(inputs: readonly HlodPackageInstanceInput[], movedIds: ReadonlySet<string>): string[] {
  const tree = buildHlodTree(inputs.map(instance => ({
    id: instance.instanceId, position: instance.sphereCenter, radius: instance.sphereRadius })));
  return [...tree.nodes.values()]
    .filter(node => node.children.length > 0 && node.instanceIds.some(id => movedIds.has(id)))
    .map(node => node.id)
    .sort();
}

describe("T26 hlodPackage diff (incremental consistency)", () => {
  it("keeps the diff minimal: only the ancestor closure of moved instances changes ids; bytes stay identical",
    async () => {
      const { inputs } = await packageInputs();
      const previous = buildHlodPackage(inputs);
      const movedIds = new Set(inputs.slice(0, MOVED_COUNT).map(instance => instance.instanceId));
      const { inputs: nextInputs, moved } = translate(inputs, movedIds, [SMALL_STEP, 0, -SMALL_STEP]);
      const next = buildHlodPackage(nextInputs);

      const diff = diffHlodPackages(previous, next);
      const expectedChanged = changedProxyNodeIds(nextInputs, movedIds);
      expect(diff.rootCellShifted).toBe(false);
      // 变更集 = 移动实例的内容祖先闭包(精确计数,来自增量失效定理)。
      expect(diff.removedGeometryIds).toHaveLength(expectedChanged.length);
      expect(diff.addedGeometryIds).toHaveLength(expectedChanged.length);
      expect(diff.unchangedProxyCount).toBe(previous.manifest.proxies.length - expectedChanged.length);
      expect(diff.unchangedProxyCount).toBe(next.manifest.proxies.length - expectedChanged.length);
      // 代理总量稳定:小步移动不改变聚合结构。
      expect(previous.manifest.proxies.length).toBe(next.manifest.proxies.length);
      expect(diff.removedGeometryIds.length / previous.manifest.proxies.length).toBeLessThan(0.05);

      // 字节闸:声明 unchanged 的代理逐字节相同;id 变的代理必有新内容。
      assertUnchangedGeometryBytes(previous, next);
      const previousGeometries = hlodGeometryById(previous);
      const nextGeometries = hlodGeometryById(next);
      for (const id of diff.removedGeometryIds) expect(nextGeometries.has(id)).toBe(false);
      for (const id of diff.addedGeometryIds) expect(previousGeometries.has(id)).toBe(false);

      // 增量树 ≡ 全量重建(deep-engine 结构性保证)→ 包级结果随之等价;
      // delta.rebuiltNodes 与包 diff 的 id 变更数互证(同一变更闭包的两种投影)。
      const previousTree = buildHlodTree(inputs.map(instance => ({
        id: instance.instanceId, position: instance.sphereCenter, radius: instance.sphereRadius })));
      const changeSet: HlodTreeChangeSet = { moved };
      const incremental = updateHlodTree(previousTree, changeSet);
      expect(incremental.tree.rootId)
        .toBe(buildHlodTree(nextInputs.map(instance => ({
          id: instance.instanceId, position: instance.sphereCenter, radius: instance.sphereRadius }))).rootId);
      expect(incremental.delta.rebuiltNodes).toBe(expectedChanged.length + MOVED_COUNT);
    });

  it("keeps untouched proxies stable even when an instance escapes the root cell", async () => {
    const { inputs } = await packageInputs();
    const previous = buildHlodPackage(inputs);
    const escapeId = inputs[0]!.instanceId;
    const { inputs: nextInputs } = translate(inputs, new Set([escapeId]), [4096, 0, 0]);
    const next = buildHlodPackage(nextInputs);
    const diff = diffHlodPackages(previous, next);
    // 根胞元重定如实上报(256 → 32768);前树中含移动实例的簇(旧闭包)全部换 id,
    // 其余簇经压缩下探收敛到同一最小胞元 ⇒ 内容哈希不变 ⇒ id 与字节都不变。
    expect(diff.rootCellShifted).toBe(true);
    const oldClosure = changedProxyNodeIds(inputs, new Set([escapeId]));
    const newClosure = changedProxyNodeIds(nextInputs, new Set([escapeId]));
    expect(diff.removedGeometryIds).toHaveLength(oldClosure.length);
    // 新树闭包 + 因成员进出而重组的邻接簇共同构成新增;账目守恒:
    expect(diff.addedGeometryIds.length).toBeGreaterThanOrEqual(newClosure.length);
    expect(next.manifest.proxies.length)
      .toBe(previous.manifest.proxies.length - diff.removedGeometryIds.length + diff.addedGeometryIds.length);
    expect(diff.unchangedProxyCount).toBe(previous.manifest.proxies.length - oldClosure.length);
    assertUnchangedGeometryBytes(previous, next);
  });

  it("is a no-op for identical inputs (empty diff, zero churn)", async () => {
    const { inputs } = await packageInputs();
    const first = buildHlodPackage(inputs);
    const second = buildHlodPackage(inputs);
    const diff = diffHlodPackages(first, second);
    expect(diff).toEqual({
      previousProxyCount: first.manifest.proxies.length,
      nextProxyCount: second.manifest.proxies.length,
      unchangedProxyCount: first.manifest.proxies.length,
      addedGeometryIds: [],
      removedGeometryIds: [],
      rootCellShifted: false,
    });
    assertUnchangedGeometryBytes(first, second);
  });
});
