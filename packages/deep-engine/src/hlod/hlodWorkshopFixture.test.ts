import { describe, expect, it } from "vitest";
import { WORKSHOP_ASSETS } from "../../lab/factoryWorkshop.js";
import { workshopAssetNodeBounds } from "./hlodWorkshopFixture.testUtils.js";

/** T00 车间 8 类资产的 GLB 包围球解析验证(真实网格数据,非估算)。 */
describe("T26 workshop GLB bounds fixture", () => {
  it("parses every frozen workshop asset with positive finite spheres", async () => {
    const nodeCounts = new Map<string, number>();
    for (const asset of WORKSHOP_ASSETS) {
      const nodes = await workshopAssetNodeBounds(asset.id);
      expect(nodes.length, asset.id).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(Number.isFinite(node.radius), node.localId).toBe(true);
        expect(node.radius, node.localId).toBeGreaterThan(0);
        expect(node.center.every(Number.isFinite), node.localId).toBe(true);
        expect(node.localMatrix).toHaveLength(16);
      }
      nodeCounts.set(asset.id, nodes.length);
    }
    // 与 T00 车间合同一致:每 bay 15 个单实例资产 + 1 台 9 mesh 节点机械臂。
    expect(nodeCounts.get("robotArm")).toBe(9);
    for (const id of ["machine", "conveyor", "crate", "hopper", "column", "catwalk", "screen"]) {
      expect(nodeCounts.get(id)).toBe(1);
    }
  });

  it("is deterministic: repeated parses yield byte-identical bounds", async () => {
    const first = JSON.stringify(await workshopAssetNodeBounds("robotArm"));
    const second = JSON.stringify(await workshopAssetNodeBounds("robotArm"));
    expect(second).toBe(first);
  });
});
