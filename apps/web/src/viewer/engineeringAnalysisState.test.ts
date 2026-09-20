import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { SceneEngineeringAnalysisState, SceneSnapshot } from "@bim-studio/contracts";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";
import {
  DEFAULT_ENGINEERING_ANALYSIS,
  applyQtoCategoryMapping,
  normalizeSceneEngineeringAnalysis,
  type QtoMappingTarget,
} from "./engineeringAnalysisState";

function target(name: string, options: { materials?: string[]; userData?: Record<string, unknown> } = {}): QtoMappingTarget {
  const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  if (options.materials?.length) {
    object.material = options.materials.map((name) => {
      const material = new THREE.MeshStandardMaterial();
      material.name = name;
      return material;
    });
  }
  object.userData = options.userData ?? {};
  return { name, kind: "model", object };
}

function scene(analysis: SceneEngineeringAnalysisState): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "工程分析场景",
    camera: { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [],
    measurements: [],
    engineeringAnalysis: analysis,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}

describe("P5/P7 engineering analysis persistence", () => {
  it("round-trips saved rules through the scene document and rejects unknown fields on restore", () => {
    const saved: SceneEngineeringAnalysisState = {
      minimumClearance: 0.8,
      heightLimit: 6.5,
      qtoMappings: [
        { id: "m1", enabled: true, source: "material-name", pattern: "Steel", category: "钢结构" },
        { id: "m2", enabled: false, source: "custom-property", pattern: "", propertyKey: "ifcType", category: "构件" },
      ],
    };
    // 模拟保存 → JSON 落盘 → 重开恢复（persistence controller 走同一 normalize 入口）。
    const restored = normalizeSceneEngineeringAnalysis(JSON.parse(JSON.stringify(saved)));
    expect(restored).toEqual(saved);

    // 未知字段与非法条目 fail-closed：字段级拒绝、条目级丢弃，不猜测。
    const dirty = normalizeSceneEngineeringAnalysis({
      minimumClearance: -3,
      heightLimit: "six",
      qtoMappings: [
        { id: "bad-source", source: "planet", category: "X" },
        { id: "no-pattern", source: "object-name", pattern: "  ", category: "Y" },
        { id: "no-key", source: "custom-property", pattern: "v", category: "Z" },
        { id: "no-category", source: "object-name", pattern: "pump", category: "  " },
        { id: "keep", enabled: true, source: "object-name", pattern: "pump", category: "泵", mystery: true },
      ],
      surprise: 1,
    });
    expect(dirty.minimumClearance).toBe(DEFAULT_ENGINEERING_ANALYSIS.minimumClearance);
    expect(dirty.heightLimit).toBe(DEFAULT_ENGINEERING_ANALYSIS.heightLimit);
    expect(dirty.qtoMappings).toEqual([
      { id: "keep", enabled: true, source: "object-name", pattern: "pump", category: "泵" },
    ]);
  });

  it("applies QTO category mappings in order with first enabled hit winning and invalid entries skipped", () => {
    const mappings = normalizeSceneEngineeringAnalysis({
      minimumClearance: 0.5,
      heightLimit: 4,
      qtoMappings: [
        { id: "a", enabled: true, source: "object-name", pattern: "PUMP", category: "泵类" },
        { id: "b", enabled: true, source: "material-name", pattern: "steel", category: "钢结构" },
        { id: "c", enabled: false, source: "object-name", pattern: "pump", category: "停用不应命中" },
        { id: "d", enabled: true, source: "object-name", pattern: "", category: "空 pattern 不应匹配一切" },
      ],
    }).qtoMappings ?? [];

    expect(applyQtoCategoryMapping(target("Pump-101"), mappings)).toBe("泵类");
    expect(applyQtoCategoryMapping(target("tank", { materials: ["STEEL-Plate"] }), mappings)).toBe("钢结构");
    expect(applyQtoCategoryMapping(target("tank", { materials: ["Aluminum"] }), mappings)).toBeUndefined();

    const custom = normalizeSceneEngineeringAnalysis({
      minimumClearance: 0.5,
      heightLimit: 4,
      qtoMappings: [
        { id: "k", enabled: true, source: "custom-property", pattern: "", propertyKey: "ifcType", category: "按键存在" },
        { id: "v", enabled: true, source: "custom-property", pattern: "wall", propertyKey: "ifcType", category: "按值包含" },
      ],
    }).qtoMappings ?? [];
    expect(applyQtoCategoryMapping(target("w1", { userData: { ifcType: "IfcWall" } }), custom)).toBe("按键存在");
    expect(applyQtoCategoryMapping(target("w2", { userData: {} }), custom)).toBeUndefined();

    const valueOnly = [custom[1]!];
    expect(applyQtoCategoryMapping(target("w1", { userData: { ifcType: "IfcWALL-01" } }), valueOnly)).toBe("按值包含");
  });

  it("rolls engineering rules back through the scene authoring history undo", () => {
    const before = scene({ minimumClearance: 0.5, heightLimit: 4, qtoMappings: [] });
    const history = new SceneAuthoringHistory();
    history.reset(before);

    const after = scene({
      minimumClearance: 1.2,
      heightLimit: 9,
      qtoMappings: [{ id: "m1", enabled: true, source: "material-name", pattern: "steel", category: "钢结构" }],
    });
    expect(history.record(after, "更新工程分析规则")).toBe(true);
    expect(history.getState().canUndo).toBe(true);

    const rolledBack = history.undo();
    expect(normalizeSceneEngineeringAnalysis(rolledBack?.engineeringAnalysis)).toEqual(
      normalizeSceneEngineeringAnalysis(before.engineeringAnalysis),
    );
    // 重做回到新规则，往返一致。
    expect(normalizeSceneEngineeringAnalysis(history.redo()?.engineeringAnalysis)).toEqual(
      normalizeSceneEngineeringAnalysis(after.engineeringAnalysis),
    );
  });
});
