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
    expect(html).not.toContain('data-step-id="data"');
    expect(html).not.toContain("必需步骤完成");
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
