import { describe, expect, it } from "vitest";
import {
  clampOntologyGraphLimit,
  ONTOLOGY_GRAPH_MAX_LIMIT,
  ontologyGraphNodeId,
  parseOntologyGraphNodeId,
  parseOntologyGraphQuery,
} from "./ontologyGraph.js";

describe("ontology graph contract", () => {
  it("节点 id 组装/解析互逆；非法 kind 拒绝", () => {
    const id = ontologyGraphNodeId("object", "Device");
    expect(id).toBe("object:Device");
    expect(parseOntologyGraphNodeId(id)).toEqual({ kind: "object", key: "Device" });
    // dataset 的 key 里含冒号（sourceId）时解析取第一个冒号分段
    expect(parseOntologyGraphNodeId("dataset:ds-a:b")).toEqual({ kind: "dataset", key: "ds-a:b" });
    expect(parseOntologyGraphNodeId("bogus:Device")).toBeUndefined();
    expect(parseOntologyGraphNodeId("object:")).toBeUndefined();
    expect(parseOntologyGraphNodeId("nodefault")).toBeUndefined();
  });

  it("parseOntologyGraphQuery：合法查询通过且 limit 被 clamp", () => {
    const parsed = parseOntologyGraphQuery({ root: { type: "object", id: "Device" }, depth: 2, limit: 999999 });
    expect(parsed).toMatchObject({ ok: true, query: { root: { type: "object", id: "Device" }, depth: 2, limit: ONTOLOGY_GRAPH_MAX_LIMIT } });
    const minimal = parseOntologyGraphQuery({ root: { type: "action", id: "diagnose_device" }, depth: 1, limit: 5, direction: "out", relationTypes: ["device_triggers_event"], includeActions: true });
    expect(minimal).toEqual({
      ok: true,
      query: { root: { type: "action", id: "diagnose_device" }, depth: 1, relationTypes: ["device_triggers_event"], direction: "out", includeActions: true, limit: 5 },
    });
  });

  it("parseOntologyGraphQuery：非法输入逐条报错（fail-closed），不静默修正深度/方向", () => {
    expect(parseOntologyGraphQuery(null)).toMatchObject({ ok: false, errors: ["图查询必须是一个对象"] });
    const bad = parseOntologyGraphQuery({ root: { type: "nope", id: "" }, depth: 9, direction: "sideways", relationTypes: "Device" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((message) => message.includes("root.type"))).toBe(true);
      expect(bad.errors.some((message) => message.includes("root.id"))).toBe(true);
      expect(bad.errors.some((message) => message.includes("depth"))).toBe(true);
      expect(bad.errors.some((message) => message.includes("direction"))).toBe(true);
      expect(bad.errors.some((message) => message.includes("relationTypes"))).toBe(true);
    }
    expect(parseOntologyGraphQuery({ root: { type: "event", id: "e" }, depth: "2", limit: 10 }).ok).toBe(false);
  });

  it("clampOntologyGraphLimit：NaN/非数值回落默认，负数/超界夹紧", () => {
    expect(clampOntologyGraphLimit(undefined)).toBe(300);
    expect(clampOntologyGraphLimit(Number.NaN)).toBe(300);
    expect(clampOntologyGraphLimit(0)).toBe(1);
    expect(clampOntologyGraphLimit(-5)).toBe(1);
    expect(clampOntologyGraphLimit(12.9)).toBe(12);
    expect(clampOntologyGraphLimit(9999)).toBe(ONTOLOGY_GRAPH_MAX_LIMIT);
  });
});
