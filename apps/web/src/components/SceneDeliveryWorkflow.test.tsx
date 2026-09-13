import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord, PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { DeliveryReviewDialog, ProjectDeliveryFlow, PublicationVersionItem } from "./SceneDeliveryWorkflow";

const timestamp = "2026-08-28T08:00:00.000Z";

describe("SceneDeliveryWorkflow", () => {
  it("在同一流程中表达就绪、待办和发布状态", () => {
    const html = renderToStaticMarkup(<ProjectDeliveryFlow
      locale="zh-CN"
      project={project()}
      scenes={[scene()]}
      defaultCollapsed={false}
      onData={vi.fn()}
      onAssets={vi.fn()}
      onDesign={vi.fn()}
      onLinkage={vi.fn()}
      onValidate={vi.fn()}
      onPublish={vi.fn()}
    />);

    expect(html).toContain("数据 → 资产 → 设计 → 联动 → 脚本 → 仿真 → 校验 → 发布");
    expect(html).toContain("缺连接或数据集");
    expect(html).toContain("1 个场景");
    expect(html).toContain("5. 行为脚本");
    expect(html).toContain("6. 仿真调试");
  });

  it("默认收起开发流程，仅保留明确的展开入口", () => {
    const html = renderToStaticMarkup(<ProjectDeliveryFlow
      locale="zh-CN"
      project={project()}
      scenes={[scene()]}
      onData={vi.fn()}
      onAssets={vi.fn()}
      onDesign={vi.fn()}
      onLinkage={vi.fn()}
      onValidate={vi.fn()}
      onPublish={vi.fn()}
    />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("展开开发流程");
    expect(html).toContain(">开发流程</button>");
    expect(html).not.toContain("必需步骤");
    expect(html).not.toContain("继续：");
    expect(html).not.toContain('data-step-id="data"');
    expect(html).not.toContain("必需步骤完成");
  });

  it("必需步骤全部完成后不再用可选步骤伪装成下一步", () => {
    const readyProject: ProjectRecord = {
      ...project(),
      dataConnections: [{
        id: "connection-1",
        projectId: "project-1",
        name: "实时源",
        type: "simulation",
        enabled: true,
        config: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      datasets: [{
        id: "dataset-1",
        projectId: "project-1",
        name: "设备数据",
        connectionId: "connection-1",
        refreshSeconds: 10,
        fields: [{ key: "temperature", label: "温度", type: "number" }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    };
    const readyScene: SceneSnapshot = {
      ...scene(),
      publishedAt: timestamp,
      dataBindings: [{
        id: "binding-1",
        name: "温度",
        enabled: true,
        datasetId: "dataset-1",
        field: "temperature",
        target: {},
        action: "color",
        refreshSeconds: 10,
      }],
    };
    const html = renderToStaticMarkup(<ProjectDeliveryFlow
      locale="zh-CN"
      project={readyProject}
      scenes={[readyScene]}
      defaultCollapsed={false}
      onData={vi.fn()}
      onAssets={vi.fn()}
      onDesign={vi.fn()}
      onLinkage={vi.fn()}
      onValidate={vi.fn()}
      onPublish={vi.fn()}
    />);

    expect(html).toContain("3/3 必需步骤");
    expect(html).not.toContain("继续：准备资产");
    expect(html).not.toContain("继续：行为脚本");
    expect(html).not.toContain("继续：仿真调试");
  });

  it("阻止存在必需缺口的发布继续操作", () => {
    const html = renderToStaticMarkup(<DeliveryReviewDialog
      locale="zh-CN"
      project={project()}
      scenes={[]}
      onClose={vi.fn()}
      onOpenData={vi.fn()}
      onOpenAssets={vi.fn()}
      onOpenScenes={vi.fn()}
      onOpenLinkage={vi.fn()}
    />);

    expect(html).toContain("必需项未通过");
    expect(html).toContain("disabled");
    expect(html).toContain("去接入数据");
    expect(html).toContain("去创建场景");
    expect(html).toContain("没有可发布场景");
    expect(html).toContain("先创建并保存一个场景");
  });

  it("发布体检显示场景上下文、问题细节和未展开数量", () => {
    const auditProject: ProjectRecord = {
      ...project(),
      dataConnections: [{ id: "connection-1", projectId: "project-1", name: "实时源", type: "simulation", enabled: true, config: {}, createdAt: timestamp, updatedAt: timestamp }],
      datasets: [{
        id: "dataset-1", projectId: "project-1", name: "设备数据", connectionId: "connection-1", refreshSeconds: 10,
        fields: [{ key: "temperature", label: "温度", type: "number" }], createdAt: timestamp, updatedAt: timestamp,
      }],
    };
    const brokenScenes = Array.from({ length: 5 }, (_, index) => ({
      ...scene(),
      id: `scene-${index + 1}`,
      name: `产线场景 ${index + 1}`,
      dataBindings: [{
        id: `binding-${index + 1}`,
        name: "温度",
        enabled: true,
        datasetId: "dataset-1",
        field: "temperature",
        target: { modelId: `missing-model-${index + 1}` },
        action: "color" as const,
        refreshSeconds: 10,
      }],
    }));
    const html = renderToStaticMarkup(<DeliveryReviewDialog
      locale="zh-CN"
      project={auditProject}
      scenes={brokenScenes}
      onClose={vi.fn()}
      onOpenData={vi.fn()}
      onOpenAssets={vi.fn()}
      onOpenScenes={vi.fn()}
      onOpenLinkage={vi.fn()}
    />);

    expect(html).toContain("产线场景 1 · 引用的模型“missing-model-1”不在当前场景");
    expect(html).toContain('data-target-scene-id="scene-1"');
    expect(html).toContain("另有 1 项，进入对应工作区逐项处理");
    expect(html).not.toContain("产线场景 5 · 引用的模型");
  });

  it("发布版本显示与当前草稿的差异证据", () => {
    const published = scene();
    const draft = { ...scene(), name: "更新后的场景" };
    const version: PublishedSceneRecord = {
      sceneId: published.id,
      projectId: published.projectId,
      name: published.name,
      snapshot: published,
      publishedAt: timestamp,
      version: 3
    };
    const html = renderToStaticMarkup(<PublicationVersionItem
      locale="zh-CN"
      draft={draft}
      version={version}
      fallbackVersion={1}
      latest={false}
      busy={false}
      onRestore={vi.fn()}
    />);

    expect(html).toContain("v3");
    expect(html).toContain("草稿有 1 类变化");
    expect(html).toContain("恢复");
  });
});

function project(): ProjectRecord {
  return { id: "project-1", name: "产线项目", description: "", models: [], createdAt: timestamp, updatedAt: timestamp };
}

function scene(): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "装配线",
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [],
    measurements: [],
    dataBindings: [],
    interactions: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
