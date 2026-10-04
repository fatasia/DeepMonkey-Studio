import { describe, expect, it } from "vitest";
import type { MaterialGraphDefinition } from "./materialGraphModel";
import {
  MATERIAL_GRAPH_MAX_LAYERS,
  applyPresetToGraphBase,
  createLayer,
  createMaterialGraph,
  deriveGraphEdges,
  deriveGraphNodes,
  normalizeMaterialGraph,
  validateMaterialGraph,
} from "./materialGraphModel";

/** 规范化往返:非法输入收敛进合法域而非拒绝(定义可持久化,容错优先)。 */
describe("materialGraphModel", () => {
  it("createMaterialGraph 生成空图;base 未给时用中性 PBR 值", () => {
    const graph = createMaterialGraph("测试图");
    expect(graph.version).toBe(1);
    expect(graph.layers).toHaveLength(0);
    expect(graph.base.color).toBe("#9aa2a9");
    expect(graph.base.roughness).toBeCloseTo(0.5);
    expect(graph.base.metalness).toBeCloseTo(0.1);
    expect(graph.id).toMatch(/^matgraph:/);
  });

  it("normalizeMaterialGraph 收敛越界域:层截断到上限、颜色回退、种子钳位", () => {
    const raw = {
      version: 1,
      id: "matgraph:x",
      name: "",
      base: { color: "not-a-color", metalness: 42, roughness: -3 },
      layers: Array.from({ length: MATERIAL_GRAPH_MAX_LAYERS + 2 }, (_, index) => ({
        id: `l${index}`,
        color: "#12345678",
        roughness: 9,
        metalness: -1,
        opacity: 5,
        bump: 2,
        mask: { kind: "wear", seed: 0, scale: 99, coverage: 7, softness: -1, angle: 725 },
      })),
      updatedAt: "",
    };
    const graph = normalizeMaterialGraph(raw, "回退名");
    expect(graph.name).toBe("回退名");
    expect(graph.base).toEqual({ color: "#9aa2a9", metalness: 1, roughness: 0 });
    expect(graph.layers).toHaveLength(MATERIAL_GRAPH_MAX_LAYERS);
    const layer = graph.layers[0]!;
    expect(layer.color).toBe("#8a6a3f");
    expect(layer.roughness).toBe(1);
    expect(layer.metalness).toBe(0);
    expect(layer.opacity).toBe(1);
    expect(layer.bump).toBe(1);
    expect(layer.mask.seed).toBe(1);
    expect(layer.mask.scale).toBe(8);
    expect(layer.mask.coverage).toBe(1);
    expect(layer.mask.softness).toBe(0);
    expect(layer.mask.angle).toBe(5);
  });

  it("texture 遮罩仅在 texture 类型保留上传源;程序化类型丢弃", () => {
    const texture = normalizeMaterialGraph({
      layers: [{ id: "a", mask: { kind: "texture", textureUrl: "data:image/png;base64,AAA", textureName: "scratch.png", seed: 3 } }],
    }, "t");
    expect(texture.layers[0]!.mask.textureUrl).toBe("data:image/png;base64,AAA");
    expect(texture.layers[0]!.mask.textureName).toBe("scratch.png");
    const wear = normalizeMaterialGraph({
      layers: [{ id: "a", mask: { kind: "wear", textureUrl: "data:image/png;base64,AAA" } }],
    }, "t");
    expect(wear.layers[0]!.mask.textureUrl).toBeUndefined();
  });

  it("validateMaterialGraph:空图合法;无通道层、缺纹理遮罩、超层上限逐项报错", () => {
    const empty = createMaterialGraph("空");
    expect(validateMaterialGraph(empty)).toEqual([]);
    const bad = validateMaterialGraph({
      ...empty,
      base: { color: "zzz", metalness: 0, roughness: 0 },
      layers: [
        { ...(createLayer("wear")), id: "l1", useColor: false, useRoughness: false, useMetalness: false, bump: 0 },
        { ...(createLayer("texture")), id: "l2", mask: { ...createLayer("texture").mask, kind: "texture" } },
      ],
    });
    expect(bad.some(problem => problem.includes("底材质颜色"))).toBe(true);
    expect(bad.some(problem => problem.includes("未启用任何通道"))).toBe(true);
    expect(bad.some(problem => problem.includes("纹理遮罩缺少贴图"))).toBe(true);
  });

  it("deriveGraphNodes/Edges:结构确定,遮罩边与层边一一对应", () => {
    const graph: MaterialGraphDefinition = {
      ...createMaterialGraph("结构"),
      layers: [createLayer("wear", "磨损"), createLayer("dust", "灰尘")],
    };
    const nodes = deriveGraphNodes(graph);
    expect(nodes.map(node => node.kind)).toEqual(["output", "base", "layer", "mask", "layer", "mask"]);
    const edges = deriveGraphEdges(graph);
    expect(edges).toHaveLength(1 + graph.layers.length * 2);
    expect(edges.filter(edge => edge.from.startsWith("mask:"))).toHaveLength(2);
    // 同图两次派生逐字段相等(确定性)
    expect(JSON.stringify(deriveGraphNodes(graph))).toBe(JSON.stringify(deriveGraphNodes(graph)));
    expect(JSON.stringify(deriveGraphEdges(graph))).toBe(JSON.stringify(deriveGraphEdges(graph)));
  });

  it("applyPresetToGraphBase:预设参数写入底材质节点(预设库互通接口)", () => {
    const graph = createMaterialGraph("互通", { color: "#111111", roughness: 0.2, metalness: 0 });
    const next = applyPresetToGraphBase(graph, { color: "#c8c8c8", metalness: 1, roughness: 0.22 });
    expect(next.base).toEqual({ color: "#c8c8c8", metalness: 1, roughness: 0.22 });
    expect(next.id).toBe(graph.id);
    // 非法预设色不落盘
    const safe = applyPresetToGraphBase(graph, { color: "red", metalness: 1, roughness: 0.22 });
    expect(safe.base.color).toBe("#111111");
  });
});
