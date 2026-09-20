import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { LoadedSceneModel } from "../viewer/viewerTypes";
import { DEFAULT_ENGINEERING_ANALYSIS } from "../viewer/engineeringAnalysisState";
import { buildEngineeringAnalysis, SceneEngineeringAnalysisPanel } from "./SceneEngineeringAnalysisPanel";

function loaded(id: string, kind: LoadedSceneModel["kind"], position: [number, number, number], userData: Record<string, unknown> = {}): LoadedSceneModel {
  const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  object.position.set(...position);
  object.userData = userData;
  return { id, name: id, kind, object, visible: true, opacity: 1 };
}

describe("SceneEngineeringAnalysisPanel", () => {
  it("reuses P5 and P7 cores for a model-to-primitive product report", () => {
    const report = buildEngineeringAnalysis([
      loaded("machine", "model", [0, 1, 0], { category: "设备", level: "一层" }),
      loaded("keepout", "primitive", [0.4, 1, 0], { category: "安全区", level: "一层" }),
    ], 0.5, 1.2);

    expect(report.spatial.objectCount).toBe(2);
    expect(report.spatial.findings.map((finding) => finding.ruleId)).toEqual([
      "model-primitive-collision", "model-primitive-clearance", "model-height", "primitive-height",
    ]);
    expect(report.spatial.summary.hardCollisionViolations).toBe(1);
    expect(report.spatial.summary.clearanceHeightViolations).toBe(2);
    expect(report.qto.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "设备", level: "一层", count: 1 }),
      expect.objectContaining({ category: "安全区", level: "一层", count: 1 }),
    ]));
  });

  it("keeps a usable QTO and height report when the scene has no primitives", () => {
    const report = buildEngineeringAnalysis([loaded("plant", "model", [0, 0, 0])], 0.5, 4);
    expect(report.spatial.findings).toHaveLength(1);
    expect(report.spatial.findings[0]?.ruleId).toBe("model-height");
    expect(report.qto.lines[0]).toMatchObject({ category: "模型", level: "未分层" });
  });

  it("aggregates QTO lines by saved mapping instead of built-in inference and keeps line objects locatable", () => {
    const report = buildEngineeringAnalysis(
      [loaded("pump-a", "model", [0, 0, 0], { level: "一层" }), loaded("tank", "model", [5, 0, 0], { level: "一层" })],
      0.5,
      4,
      [{ id: "m1", enabled: true, source: "object-name", pattern: "pump", category: "泵类" }],
    );
    expect(report.qto.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "泵类", level: "一层", count: 1 }),
      expect.objectContaining({ category: "模型", level: "一层", count: 1 }),
    ]));
    expect(report.qtoLineObjects["泵类∥一层"]).toEqual(["pump-a"]);
    expect(report.qtoLineObjects["模型∥一层"]).toEqual(["tank"]);
  });

  it("renders an actionable empty state instead of enabled no-op exports", () => {
    const html = renderToStaticMarkup(
      <SceneEngineeringAnalysisPanel
        locale="zh-CN" sceneName="空场景" models={[]}
        value={structuredClone(DEFAULT_ENGINEERING_ANALYSIS)}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("当前没有可分析的可见对象");
    expect(html).toContain("载入模型或显示已隐藏对象后重试");
    expect(html).not.toContain("空间报告 JSON");
  });

  it("rejects invalid engineering thresholds before running core algorithms", () => {
    const models = [loaded("plant", "model", [0, 0, 0])];
    expect(() => buildEngineeringAnalysis(models, -1, 4)).toThrow("最小净空必须为非负数");
    expect(() => buildEngineeringAnalysis(models, 1, 0)).toThrow("限高必须大于 0");
  });
});
