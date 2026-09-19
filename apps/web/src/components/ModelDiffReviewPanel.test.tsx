import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import type { ComponentRecord } from "../viewer/analysis";
import { diffHighlightEntries, diffIdentityOf, modelDiffSnapshotStore, runModelDiff } from "./modelDiffReviewModel";
import { ModelDiffReportView, ModelDiffReviewPanel } from "./ModelDiffReviewPanel";

function modelRow(id: string, name: string): LoadedSceneModel {
  return { id, name, object: {} as LoadedSceneModel["object"], kind: "model", visible: true, opacity: 1 };
}

function record(modelId: string, nodeId: string, overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: nodeId,
    stableId: `${modelId}:${nodeId}`,
    modelId,
    modelName: "",
    name: overrides.name ?? nodeId,
    type: "墙",
    path: `厂房/${nodeId}`,
    level: "一层",
    category: "墙",
    properties: overrides.properties ?? {},
    searchText: "",
    ...overrides,
  };
}

describe("ModelDiffReviewPanel", () => {
  it("guides users to load instances before any snapshot exists", () => {
    const html = renderToStaticMarkup(
      <ModelDiffReviewPanel locale="zh-CN" engine={undefined} models={[]} onLocate={() => undefined} onClose={() => undefined} />,
    );
    expect(html).toContain("模型版本对比评审");
    expect(html).toContain("场景中还没有模型实例");
    expect(html).toContain("先捕获两个快照");
    expect(html).not.toContain("运行对比");
  });

  it("lists loaded model instances with capture actions and keeps diff actions hidden until snapshots exist", () => {
    const html = renderToStaticMarkup(
      <ModelDiffReviewPanel
        locale="zh-CN"
        engine={undefined}
        models={[modelRow("a", "厂房 v1"), modelRow("b", "厂房 v2")]}
        onLocate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("厂房 v1");
    expect(html).toContain("厂房 v2");
    expect((html.match(/捕获快照/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("运行对比");
    expect(html).not.toContain("三色高亮");
  });

  it("exposes snapshot pickers and the run action once snapshots are captured", () => {
    const added = modelDiffSnapshotStore.add({
      modelId: "instance-a",
      modelName: "厂房 v1",
      capturedAt: "2026-09-19T08:00:00.000Z",
      records: [record("instance-a", "ifc:1", { name: "外墙 A" })],
    });
    const html = renderToStaticMarkup(
      <ModelDiffReviewPanel
        locale="zh-CN"
        engine={undefined}
        models={[modelRow("a", "厂房 v1")]}
        onLocate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("运行对比");
    expect(html).toContain(added.label);
    expect(html).toContain("对比基线（before）");
    modelDiffSnapshotStore.remove(added.id);
  });
});

describe("ModelDiffReportView", () => {
  const before = {
    modelId: "instance-a",
    modelName: "厂房 v1",
    capturedAt: "2026-09-19T08:00:00.000Z",
    records: [
      record("instance-a", "ifc:1", { name: "保留墙" }),
      record("instance-a", "ifc:2", { name: "原外墙", properties: { FireRating: "1h" } }),
      record("instance-a", "ifc:3", { name: "旧门洞" }),
    ],
  };
  const after = {
    modelId: "instance-b",
    modelName: "厂房 v2",
    capturedAt: "2026-09-19T09:00:00.000Z",
    records: [
      record("instance-b", "ifc:1", { name: "保留墙" }),
      record("instance-b", "ifc:2", { name: "外墙 B", properties: { FireRating: "2h" } }),
      record("instance-b", "ifc:4", { name: "新门洞" }),
    ],
  };
  const report = runModelDiff(before, after);

  it("renders summary chips and all three change lists from a real diff report", () => {
    const html = renderToStaticMarkup(
      <ModelDiffReportView locale="zh-CN" report={report} highlightOn={false} working={false} onToggleHighlight={() => undefined} onLocate={() => undefined} />,
    );
    expect(html).toContain("新增 1");
    expect(html).toContain("删除 1");
    expect(html).toContain("修改 1");
    expect(html).toContain("未变化 1");
    expect(html).toContain("新门洞");
    expect(html).toContain("旧门洞");
    expect(html).toContain("外墙 B");
    expect(html).toContain("properties.FireRating: 1h → 2h");
    expect(html).toContain("三色高亮");
    expect((html.match(/>定位</g) ?? []).length).toBe(3);
  });

  it("reports an honest empty diff and disables the highlight toggle", () => {
    const empty = runModelDiff(before, {
      ...before,
      modelId: "instance-b",
      records: before.records.map((item) => ({ ...item, modelId: "instance-b", stableId: `instance-b:${diffIdentityOf(item)}` })),
    });
    const html = renderToStaticMarkup(
      <ModelDiffReportView locale="zh-CN" report={empty} highlightOn={false} working={false} onToggleHighlight={() => undefined} onLocate={() => undefined} />,
    );
    expect(html).toContain("两个快照记录完全一致");
    expect(html).toMatch(/model-diff-highlight-toggle[^>]*disabled/);
  });

  it("highlight targets cover added/removed/modified for the scene overlay", () => {
    expect(diffHighlightEntries(report)).toEqual([
      { modelId: "instance-b", nodeId: "ifc:4", kind: "added" },
      { modelId: "instance-a", nodeId: "ifc:3", kind: "removed" },
      { modelId: "instance-b", nodeId: "ifc:2", kind: "modified" },
    ]);
  });
});
