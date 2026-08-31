import { describe, expect, it } from "vitest";
import type { ComponentRecord } from "../viewer/analysis";
import {
  assertBindingWorkload,
  componentRecordsToBindingObjects,
  parseSmartBindingCatalog,
} from "./smartAssetBindingCatalog";

describe("smart asset binding catalog", () => {
  it("parses a wrapped JSON catalog with aliases and nested coordinates", () => {
    const result = parseSmartBindingCatalog(JSON.stringify({ devices: [{
      设备编号: "P-101",
      设备名称: "循环泵 101",
      标签: "pump-101|冷却水",
      区域: "A 区",
      类型: "泵",
      position: { x: 10, y: 2, z: -3 },
    }] }));

    expect(result).toEqual([{
      deviceId: "P-101",
      name: "循环泵 101",
      tags: ["pump-101", "冷却水"],
      space: "A 区",
      category: "泵",
      position: { x: 10, y: 2, z: -3 },
    }]);
  });

  it("keeps quoted CSV values intact and accepts flat coordinates", () => {
    const result = parseSmartBindingCatalog(
      'deviceId,name,tags,space,category,x,y,z\nV-01,"阀门, 入口","valve-1|入口",一层,阀门,1.5,2,3',
      "csv",
    );

    expect(result[0]).toMatchObject({
      deviceId: "V-01",
      name: "阀门, 入口",
      tags: ["valve-1", "入口"],
      position: { x: 1.5, y: 2, z: 3 },
    });
  });

  it("rejects duplicate identifiers and partial coordinates instead of dropping rows", () => {
    expect(() => parseSmartBindingCatalog('[{"deviceId":"A","name":"a"},{"deviceId":"A","name":"b"}]')).toThrow("设备编号重复：A");
    expect(() => parseSmartBindingCatalog('[{"deviceId":"A","name":"a","x":1}]')).toThrow("坐标必须包含有限数值 X、Y");
  });

  it("adapts component records without inventing absent coordinates", () => {
    const component = record({ properties: { deviceId: "P-101" }, level: "一层", category: "泵" });
    const withPosition = record({ stableId: "model:P-102", properties: { X: "1", Y: "2", Z: "3" } });
    const partialPosition = record({ stableId: "model:P-103", properties: { X: "1" } });

    expect(componentRecordsToBindingObjects([component, withPosition])).toEqual([
      expect.objectContaining({ id: "model:P-101", category: "泵", properties: expect.objectContaining({ space: "一层" }) }),
      expect.objectContaining({ id: "model:P-102", position: { x: 1, y: 2, z: 3 } }),
    ]);
    expect(componentRecordsToBindingObjects([component])[0]).not.toHaveProperty("position");
    expect(componentRecordsToBindingObjects([partialPosition])[0]).not.toHaveProperty("position");
  });

  it("blocks workloads that would freeze the browser", () => {
    expect(() => assertBindingWorkload(1_000, 251)).toThrow("超过 25 万个候选对");
    expect(() => assertBindingWorkload(1_000, 250)).not.toThrow();
  });
});

function record(patch: Partial<ComponentRecord>): ComponentRecord {
  return {
    id: "node-1",
    stableId: "model:P-101",
    modelId: "model",
    modelName: "厂房",
    name: "循环泵 101",
    type: "Mesh",
    path: "厂房 / 一层 / 循环泵 101",
    properties: {},
    searchText: "循环泵 101",
    ...patch,
  };
}
