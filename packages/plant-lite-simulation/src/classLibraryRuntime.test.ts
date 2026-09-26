/**
 * 类库与层级建模测试(西门子 Plant Simulation 类语义对位,P0-A)。
 * 本文件覆盖运行时语义三层:继承链合并 → 实例化 → 属性级断继承开关;
 * 校验拒绝与端到端等价性见 classLibraryEquivalence.test.ts。
 */

import { describe, expect, it } from "vitest";
import type { PlantClassDefinition, PlantLiteModel, PlantLiteNode } from "./modelTypes.js";
import { validatePlantLiteModel } from "./modelValidation.js";
import {
  instantiateClass,
  resolveClassChain,
  resolveClassTemplate,
  setInstanceOverride,
  propagateClassChange,
} from "./classLibraryRuntime.js";

const det = (value: number) => ({ kind: "deterministic" as const, value });

/** 三级继承:base(st 节拍 1.0 + mc)→ mid(st 提速到 2.0、新增 buf)→ leaf(mc 扩容到 2)。 */
function threeLevelLibrary(): PlantClassDefinition[] {
  return [
    {
      classId: "base",
      name: "基础工位类",
      nodes: [{ id: "st", name: "加工", kind: "station", processingTime: det(1), resourceId: "mc" }],
      resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
    },
    {
      classId: "mid",
      name: "中段单元类",
      extendsClassId: "base",
      nodes: [{ id: "st", name: "加工", kind: "station", processingTime: det(2) }, { id: "buf", name: "缓存", kind: "queue-buffer", capacity: 4 }],
    },
    {
      classId: "leaf",
      name: "末端单元类",
      extendsClassId: "mid",
      nodes: [],
      resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 2 }],
    },
  ];
}

describe("继承链合并", () => {
  it("子类属性覆写父类同 id 实体,未声明属性逐项继承,子类独有实体追加", () => {
    const template = resolveClassTemplate(threeLevelLibrary(), "leaf");
    expect(template.classIds).toEqual(["base", "mid", "leaf"]);
    const st = template.nodes.find((node) => node.id === "st");
    const buf = template.nodes.find((node) => node.id === "buf");
    const mc = template.resources.find((resource) => resource.id === "mc");
    expect(st).toMatchObject({ kind: "station", processingTime: det(2), resourceId: "mc" });
    expect(buf).toMatchObject({ kind: "queue-buffer", capacity: 4 });
    expect(mc).toMatchObject({ kind: "equipment", capacity: 2 });
  });

  it("合并结果与模板无共享引用(改合并结果不污染类库)", () => {
    const template = resolveClassTemplate(threeLevelLibrary(), "leaf");
    (template.nodes[0] as { processingTime: unknown }).processingTime = det(99);
    expect(threeLevelLibrary()[0]!.nodes[0]).toMatchObject({ processingTime: det(1) });
  });

  it("继承环、未知父类、kind 冲突显式抛错", () => {
    const cyclic: PlantClassDefinition[] = [
      { classId: "a", name: "A", extendsClassId: "b", nodes: [] },
      { classId: "b", name: "B", extendsClassId: "a", nodes: [] },
    ];
    expect(() => resolveClassChain(cyclic, "a")).toThrow(/环/);
    expect(() => resolveClassChain(threeLevelLibrary(), "ghost")).toThrow(/未知类/);
    const kindClash: PlantClassDefinition[] = [
      { classId: "root", name: "R", nodes: [{ id: "st", name: "加工", kind: "station", processingTime: det(1) }] },
      { classId: "child", name: "C", extendsClassId: "root", nodes: [{ id: "st", name: "改动", kind: "sink" }] },
    ];
    expect(() => resolveClassTemplate(kindClash, "child")).toThrow(/kind/);
  });
});

describe("实例化", () => {
  const empty: PlantLiteModel = { id: "m", name: "模型", nodes: [], edges: [] };
  const withCell = (model: PlantLiteModel): PlantLiteModel => ({ ...model, classLibrary: threeLevelLibrary() });

  it("实例 id 三段式、标记来源类、内部资源引用改写为实例资源", () => {
    const instantiated = instantiateClass(withCell(empty), "leaf");
    const st = instantiated.nodes.find((node) => node.id === "leaf.1.st");
    expect(st).toMatchObject({ inheritedFromClassId: "leaf", resourceId: "leaf.1.mc", processingTime: det(2) });
    expect(instantiated.resources?.map((resource) => resource.id)).toEqual(["leaf.1.mc"]);
    expect(instantiated.nodes.map((node) => node.id)).toEqual(["leaf.1.st", "leaf.1.buf"]);
    expect(empty.nodes).toHaveLength(0);
  });

  it("同类再次实例化序号递增,产物可整体通过模型校验", () => {
    const doubled = instantiateClass(instantiateClass(withCell(empty), "leaf"), "leaf");
    const wired: PlantLiteModel = {
      ...doubled,
      nodes: [
        ...doubled.nodes,
        { id: "src", name: "公共来料", kind: "source", interarrivalTime: det(1) },
        { id: "snk", name: "公共出货", kind: "sink" },
      ],
      edges: [
        { id: "s1", from: "src", to: "leaf.1.buf" },
        { id: "s2", from: "src", to: "leaf.2.buf" },
        { id: "w1", from: "leaf.1.buf", to: "leaf.1.st" },
        { id: "w2", from: "leaf.2.buf", to: "leaf.2.st" },
        { id: "o1", from: "leaf.1.st", to: "snk" },
        { id: "o2", from: "leaf.2.st", to: "snk" },
      ],
    };
    expect(validatePlantLiteModel(wired).issues).toEqual([]);
  });

  it("指向模型级共享资源的引用不被改写;未知类与未配类库抛错", () => {
    const shared: PlantClassDefinition[] = [
      { classId: "c", name: "C", nodes: [{ id: "st", name: "加工", kind: "station", processingTime: det(1), resourceId: "shared-mc" }] },
    ];
    const model: PlantLiteModel = {
      ...empty,
      classLibrary: shared,
      resources: [{ id: "shared-mc", name: "共享机床", kind: "equipment", capacity: 1 }],
    };
    const node = instantiateClass(model, "c").nodes[0] as Extract<PlantLiteNode, { kind: "station" }>;
    expect(node.resourceId).toBe("shared-mc");
    expect(() => instantiateClass(withCell(empty), "ghost")).toThrow(/未知类/);
    expect(() => instantiateClass(empty, "base")).toThrow(/classLibrary/);
  });
});

describe("属性级断继承开关", () => {
  const singleCellLibrary = (): PlantClassDefinition[] => [
    { classId: "cell", name: "单元类", nodes: [{ id: "st", name: "加工", kind: "station", processingTime: det(1) }] },
  ];
  const modelWithTwoInstances = (): PlantLiteModel => {
    const once = instantiateClass({ id: "m", name: "模型", nodes: [], edges: [], classLibrary: singleCellLibrary() }, "cell");
    return instantiateClass(once, "cell");
  };

  it("override 属性改类不传播,其余属性仍传播,传播计数只计实际变化", () => {
    const model = modelWithTwoInstances();
    const first = model.nodes.find((node) => node.id === "cell.1.st")!;
    setInstanceOverride(first, "processingTime", det(3));
    expect(first.propertyOverrides).toEqual({ processingTime: det(3) });

    const result = propagateClassChange(model, "cell", { set: { "st.processingTime": det(5), "st.yieldRate": 0.9 } });
    expect(result).toEqual({ classId: "cell", affectedInstances: 2 });
    expect(first).toMatchObject({ processingTime: det(3), yieldRate: 0.9 });
    const second = model.nodes.find((node) => node.id === "cell.2.st")!;
    expect(second).toMatchObject({ processingTime: det(5), yieldRate: 0.9 });
    expect(second.propertyOverrides).toBeUndefined();
    expect(model.classLibrary![0]!.nodes[0]).toMatchObject({ processingTime: det(5) });
  });

  it("只改被覆写属性时仅未断继承的实例计数(断继承生效的直接证据)", () => {
    const model = modelWithTwoInstances();
    setInstanceOverride(model.nodes.find((node) => node.id === "cell.1.st")!, "processingTime", det(3));
    const result = propagateClassChange(model, "cell", { set: { "st.processingTime": det(7) } });
    expect(result.affectedInstances).toBe(1);
    expect(model.nodes.find((node) => node.id === "cell.1.st")).toMatchObject({ processingTime: det(3) });
  });

  it("身份字段、未知路径与非 JSON 值拒绝;传播键格式错误拒绝", () => {
    const model = modelWithTwoInstances();
    const instance = model.nodes[0]!;
    expect(() => setInstanceOverride(instance, "id", "x")).toThrow(/身份字段/);
    expect(() => setInstanceOverride(instance, "name", "x")).toThrow(/身份字段/);
    expect(() => setInstanceOverride(instance, "speed", 1)).toThrow(/override 路径不存在/);
    expect(() => setInstanceOverride(instance, "processingTime", () => 1)).toThrow(/JSON/);
    expect(() => propagateClassChange(model, "cell", { set: { "st": det(1) } })).toThrow(/变更键/);
    expect(() => propagateClassChange(model, "cell", { set: { "ghost.processingTime": det(1) } })).toThrow(/不存在实体/);
    expect(() => propagateClassChange(model, "ghost", { set: {} })).toThrow(/未知类/);
  });
});
