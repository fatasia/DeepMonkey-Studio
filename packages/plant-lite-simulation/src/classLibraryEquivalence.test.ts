/**
 * 类库模型校验拒绝与端到端等价性测试(P0-A 收口)。
 * 等价性是"不是壳子"的证明:类库实例化模型与手写等价平面模型
 * 在同 seed 下跑 runPlantLiteExperiment,结果指纹逐字一致。
 */

import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "./engine.js";
import { assertPlantLiteModel, validatePlantLiteModel } from "./modelValidation.js";
import type { PlantClassDefinition, PlantLiteModel } from "./modelTypes.js";
import {
  instantiateClass,
  propagateClassChange,
  setInstanceOverride,
} from "./classLibraryRuntime.js";

const det = (value: number) => ({ kind: "deterministic" as const, value });

function validModel(): PlantLiteModel {
  return {
    id: "base-model",
    name: "基础模型",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: det(1) },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [{ id: "e1", from: "src", to: "snk" }],
  };
}

function baseCell(): PlantClassDefinition {
  return {
    classId: "base",
    name: "基础工位类",
    nodes: [{ id: "st", name: "加工", kind: "station", processingTime: det(1), resourceId: "mc" }],
    resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
  };
}

describe("模型校验拒绝", () => {
  it("继承环拒绝", () => {
    const model: PlantLiteModel = {
      ...validModel(),
      classLibrary: [
        { classId: "a", name: "A", extendsClassId: "b", nodes: [] },
        { classId: "b", name: "B", extendsClassId: "a", nodes: [] },
      ],
    };
    expect(validatePlantLiteModel(model).issues.some((issue) => issue.message.includes("环"))).toBe(true);
  });

  it("未知父类、classId 路径不安全、classId 重复拒绝", () => {
    const orphan: PlantLiteModel = {
      ...validModel(),
      classLibrary: [{ classId: "a", name: "A", extendsClassId: "ghost", nodes: [] }],
    };
    expect(validatePlantLiteModel(orphan).issues.some((issue) => issue.message.includes("未知父类"))).toBe(true);
    const unsafe: PlantLiteModel = {
      ...validModel(),
      classLibrary: [{ classId: "bad.id", name: "B", nodes: [] }],
    };
    expect(validatePlantLiteModel(unsafe).issues.some((issue) => issue.message.includes("以字母或数字开头"))).toBe(true);
    const duplicate: PlantLiteModel = {
      ...validModel(),
      classLibrary: [
        { classId: "a", name: "A", nodes: [] },
        { classId: "a", name: "A2", nodes: [] },
      ],
    };
    expect(validatePlantLiteModel(duplicate).issues.some((issue) => issue.message.includes("classId 重复"))).toBe(true);
  });

  it("实例覆写未知路径与未知类拒绝;模板携带簿记字段拒绝", () => {
    const overridden: PlantLiteModel = {
      ...validModel(),
      classLibrary: [baseCell()],
      nodes: [
        ...validModel().nodes,
        { ...baseCell().nodes[0]!, id: "base.1.st", inheritedFromClassId: "base" },
      ],
    };
    (overridden.nodes.at(-1) as { propertyOverrides?: Record<string, unknown> }).propertyOverrides = { speed: 1 };
    expect(validatePlantLiteModel(overridden).issues.some((issue) => issue.message.includes("override 路径不存在"))).toBe(true);
    (overridden.nodes.at(-1) as { propertyOverrides?: Record<string, unknown>; inheritedFromClassId?: string }).inheritedFromClassId = "ghost";
    expect(validatePlantLiteModel(overridden).issues.some((issue) => issue.message.includes("未知类"))).toBe(true);
    const bookkeeping: PlantLiteModel = {
      ...validModel(),
      classLibrary: [{
        ...baseCell(),
        nodes: [{ ...baseCell().nodes[0]!, propertyOverrides: { processingTime: det(9) } }],
      }],
    };
    expect(validatePlantLiteModel(bookkeeping).issues.some((issue) => issue.message.includes("簿记字段"))).toBe(true);
  });
});

describe("端到端等价性:类库实例化模型与手写平面模型指纹逐字一致", () => {
  const SEED = "class-equivalence-2026-09-26";
  const LIMITS = { durationMinutes: 480, warmupMinutes: 60 } as const;

  /** 1 个标准产线类(src→buf→st→snk + mc)实例化 2 条线,实例 2 覆写节拍 1.1→1.4。 */
  function classDrivenModel(): PlantLiteModel {
    const library: PlantClassDefinition[] = [
      {
        classId: "line",
        name: "标准产线类",
        nodes: [
          { id: "src", name: "来料", kind: "source", interarrivalTime: det(0.9) },
          { id: "buf", name: "线边缓存", kind: "queue-buffer", capacity: 6 },
          { id: "st", name: "加工", kind: "station", processingTime: det(1.1), resourceId: "mc" },
          { id: "snk", name: "出货", kind: "sink" },
        ],
        resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
      },
    ];
    const once = instantiateClass({ id: "class-driven", name: "类库驱动", nodes: [], edges: [], classLibrary: library }, "line");
    const twice = instantiateClass(once, "line");
    setInstanceOverride(twice.nodes.find((node) => node.id === "line.2.st")!, "processingTime", det(1.4));
    return {
      ...twice,
      edges: [
        { id: "e1", from: "line.1.src", to: "line.1.buf" },
        { id: "e2", from: "line.1.buf", to: "line.1.st" },
        { id: "e3", from: "line.1.st", to: "line.1.snk" },
        { id: "e4", from: "line.2.src", to: "line.2.buf" },
        { id: "e5", from: "line.2.buf", to: "line.2.st" },
        { id: "e6", from: "line.2.st", to: "line.2.snk" },
      ],
    };
  }

  function flatModel(): PlantLiteModel {
    return {
      id: "class-driven",
      name: "类库驱动",
      nodes: [
        { id: "line.1.src", name: "来料", kind: "source", interarrivalTime: det(0.9) },
        { id: "line.1.buf", name: "线边缓存", kind: "queue-buffer", capacity: 6 },
        { id: "line.1.st", name: "加工", kind: "station", processingTime: det(1.1), resourceId: "line.1.mc" },
        { id: "line.1.snk", name: "出货", kind: "sink" },
        { id: "line.2.src", name: "来料", kind: "source", interarrivalTime: det(0.9) },
        { id: "line.2.buf", name: "线边缓存", kind: "queue-buffer", capacity: 6 },
        { id: "line.2.st", name: "加工", kind: "station", processingTime: det(1.4), resourceId: "line.2.mc" },
        { id: "line.2.snk", name: "出货", kind: "sink" },
      ],
      edges: [
        { id: "e1", from: "line.1.src", to: "line.1.buf" },
        { id: "e2", from: "line.1.buf", to: "line.1.st" },
        { id: "e3", from: "line.1.st", to: "line.1.snk" },
        { id: "e4", from: "line.2.src", to: "line.2.buf" },
        { id: "e5", from: "line.2.buf", to: "line.2.st" },
        { id: "e6", from: "line.2.st", to: "line.2.snk" },
      ],
      resources: [
        { id: "line.1.mc", name: "机床", kind: "equipment", capacity: 1 },
        { id: "line.2.mc", name: "机床", kind: "equipment", capacity: 1 },
      ],
    };
  }

  it("类库模型通过校验,两侧实验结果指纹与指标逐字一致", () => {
    const classModel = assertPlantLiteModel(classDrivenModel());
    const classRun = runPlantLiteExperiment({ model: classModel, seed: SEED, replications: 3, limits: { ...LIMITS } });
    const flatRun = runPlantLiteExperiment({ model: flatModel(), seed: SEED, replications: 3, limits: { ...LIMITS } });
    expect(fingerprint64Labeled([["result", classRun]])).toBe(fingerprint64Labeled([["result", flatRun]]));
    expect(classRun.replications.map((replication) => replication.completedItems))
      .toEqual(flatRun.replications.map((replication) => replication.completedItems));
    expect(classRun.confidence95.throughputPerHour.mean).toBe(flatRun.confidence95.throughputPerHour.mean);
    expect(classRun.replications[0]?.completedItems).toBeGreaterThan(0);
  });

  it("改类传播改变仿真结果且保持确定性(传播不是摆设)", () => {
    const before = runPlantLiteExperiment({ model: classDrivenModel(), seed: SEED, replications: 3, limits: { ...LIMITS } });
    const slowed = classDrivenModel();
    const propagation = propagateClassChange(slowed, "line", { set: { "st.processingTime": det(1.8) } });
    expect(propagation.affectedInstances).toBe(2);
    const after = runPlantLiteExperiment({ model: slowed, seed: SEED, replications: 3, limits: { ...LIMITS } });
    const afterAgain = runPlantLiteExperiment({ model: slowed, seed: SEED, replications: 3, limits: { ...LIMITS } });
    expect(fingerprint64Labeled([["result", before]])).not.toBe(fingerprint64Labeled([["result", after]]));
    expect(fingerprint64Labeled([["result", after]])).toBe(fingerprint64Labeled([["result", afterAgain]]));
  });
});
