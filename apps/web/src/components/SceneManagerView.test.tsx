import type { SceneSnapshot } from "@bim-studio/contracts";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneManagerController } from "./SceneManager";
import { SceneManagerView } from "./SceneManagerView";

describe("SceneManagerView product surface", () => {
  it("keeps the thumbnail primary and exposes the five frequent scene actions", () => {
    const scene = createScene();
    const html = renderToStaticMarkup(<SceneManagerView controller={{
      branding: { systemName: "DeepMonkey Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "DeepMonkey Studio" },
      busy: false,
      cloudConfigured: false,
      cloudSceneLinks: {},
      cloudScenePolicies: {},
      isAdmin: false,
      navigationNotice: "页面不存在，已返回项目工作台",
      locale: "zh-CN",
      managerTab: "scenes",
      name: "",
      projects: [],
      publicationVersions: [],
      publishMode: "webgl",
      publishPerformance: "standard",
      scenes: [scene],
      sceneSearch: "",
      sceneSort: "updated",
      sceneStatusFilter: "all",
      showcaseBusy: false,
      showcaseExists: false,
      sortedScenes: [scene],
      topologies: [],
      userName: "审计用户",
      versionBusy: false,
      visibleScenes: [scene],
    } as unknown as SceneManagerController} />);

    expect(html).toContain("DeepMonkey Studio");
    expect(html).toContain('role="status"');
    expect(html).toContain("页面不存在，已返回项目工作台");
    expect(html).toContain('aria-label="关闭页面提示"');
    expect(html).toContain("变更于");
    expect(html).toContain("scene-card-thumbnail");
    expect(html).toContain("--scene-thumbnail-color:#2878c7");
    expect(html).toContain('aria-label="预览场景"');
    expect(html).toContain('aria-label="发布场景"');
    expect(html).not.toContain('aria-label="复制发布链接"');
    expect(html).toContain("重命名场景");
    expect(html).toContain('aria-label="编辑场景"');
    expect(html).toContain('aria-label="资源"');
    expect(html).toContain('aria-label="切换语言"');
    expect(html).toContain('aria-label="退出 · 审计用户"');
    expect(html).not.toMatch(/资源库|资源中心|素材/);
  });

  it("gives topology preview cards a task-oriented accessible name", () => {
    const html = renderToStaticMarkup(<SceneManagerView controller={{
      branding: { systemName: "DeepMonkey Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "DeepMonkey Studio" },
      busy: false,
      cloudConfigured: false,
      cloudSceneLinks: {},
      cloudScenePolicies: {},
      isAdmin: false,
      locale: "zh-CN",
      managerTab: "topology",
      name: "",
      projects: [],
      publicationVersions: [],
      publishMode: "webgl",
      publishPerformance: "standard",
      scenes: [],
      sceneSearch: "",
      sceneSort: "updated",
      sceneStatusFilter: "all",
      showcaseBusy: false,
      showcaseExists: false,
      sortedScenes: [],
      topologies: [{
        applicationId: "application-1",
        applicationName: "装配项目",
        topology: { id: "topology-1", name: "总装线物流拓扑", nodes: [], edges: [] },
      }],
      userName: "审计用户",
      versionBusy: false,
      visibleScenes: [],
    } as unknown as SceneManagerController} />);

    expect(html).toContain('aria-label="打开拓扑 · 总装线物流拓扑"');
    expect(html).toContain('title="打开拓扑 · 总装线物流拓扑"');
  });

  it("shows three runnable capability cases in the examples tab", () => {
    const project = { id: "project-1", name: "装配项目", description: "", models: [], createdAt: "2026-09-06", updatedAt: "2026-09-06" };
    const html = renderToStaticMarkup(<SceneManagerView controller={{
      branding: { systemName: "DeepMonkey Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "DeepMonkey Studio" },
      busy: false, cloudConfigured: false, cloudSceneLinks: {}, cloudScenePolicies: {}, isAdmin: false,
      locale: "zh-CN", managerTab: "examples", name: "", project, projects: [project], scenes: [], sortedScenes: [], visibleScenes: [],
      publicationVersions: [], publishMode: "webgl", publishPerformance: "standard", showcaseBusy: false, showcaseExists: false,
      topologies: [], userName: "审计用户", versionBusy: false, sceneSearch: "", sceneSort: "updated", sceneStatusFilter: "all",
    } as unknown as SceneManagerController} />);

    expect(html).toContain("智造园区综合案例");
    expect(html).toContain("设备运维与能效案例");
    expect(html).toContain("仓储物流与路径仿真案例");
    expect(html).toContain("打开物流仿真");
    expect(html).toContain("AGV ROUTING");
    expect(html).toContain("打开运维案例");
    expect(html).toContain("ASSET LEDGER");
    expect(html).toContain('aria-label="内置综合案例"');
  });

  it("routes the operations and logistics case buttons to their intended operations tabs", () => {
    const project = { id: "project-1", name: "装配项目", description: "", models: [], createdAt: "2026-09-06", updatedAt: "2026-09-06" };
    const openedTabs: (string | undefined)[] = [];
    const controller = {
      branding: { systemName: "DeepMonkey Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "DeepMonkey Studio" },
      busy: false, cloudConfigured: false, cloudSceneLinks: {}, cloudScenePolicies: {}, isAdmin: false,
      locale: "zh-CN", managerTab: "examples", name: "", project, projects: [project], scenes: [], sortedScenes: [], visibleScenes: [],
      publicationVersions: [], publishMode: "webgl", publishPerformance: "standard", showcaseBusy: false, showcaseExists: false,
      topologies: [], userName: "审计用户", versionBusy: false, sceneSearch: "", sceneSort: "updated", sceneStatusFilter: "all",
      onOperationsCenter: (tab?: string) => openedTabs.push(tab),
    } as unknown as SceneManagerController;

    const view = SceneManagerView({ controller });
    const caseButtons = collectButtons(view).filter((button) => String(button.props.className).includes("manager-showcase-action"));
    expect(caseButtons).toHaveLength(3);
    caseButtons[1]?.props.onClick?.({} as never);
    caseButtons[2]?.props.onClick?.({} as never);

    expect(openedTabs).toEqual([undefined, "logistics"]);
  });

  it.each([
    { name: "genuinely empty", scenes: [], visibleScenes: [], toolbarClass: "button", emptyAction: true },
    { name: "filtered empty", scenes: [createScene()], visibleScenes: [], toolbarClass: "button primary", emptyAction: false },
    { name: "populated", scenes: [createScene()], visibleScenes: [createScene()], toolbarClass: "button primary", emptyAction: false },
  ])("keeps one scene creation emphasis for a $name directory", ({ scenes, visibleScenes, toolbarClass, emptyAction }) => {
    const project = { id: "project-1", name: "装配项目", description: "", models: [], createdAt: "2026-09-06", updatedAt: "2026-09-06" };
    const html = renderToStaticMarkup(<SceneManagerView controller={{
      branding: { systemName: "DeepMonkey Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "DeepMonkey Studio" },
      busy: false,
      cloudConfigured: false,
      cloudSceneLinks: {},
      cloudScenePolicies: {},
      isAdmin: false,
      locale: "zh-CN",
      managerTab: "scenes",
      name: "",
      project,
      projects: [project],
      publicationVersions: [],
      publishMode: "webgl",
      publishPerformance: "standard",
      scenes,
      sceneSearch: visibleScenes.length < scenes.length ? "不存在的场景" : "",
      sceneSort: "updated",
      sceneStatusFilter: "all",
      showcaseBusy: false,
      showcaseExists: false,
      sortedScenes: scenes,
      topologies: [],
      userName: "审计用户",
      versionBusy: false,
      visibleScenes,
    } as unknown as SceneManagerController} />);

    expect(buttonClass(html, "新建场景")).toBe(toolbarClass);
    expect(buttonClass(html, "新建第一个场景")).toBe(emptyAction ? "button primary" : undefined);
    expect(buttonClass(html, "导入")).toBe("button");
    expect(html.includes("没有匹配的场景")).toBe(scenes.length > 0 && visibleScenes.length === 0);
    expect(html.match(/<button[^>]*class="button primary"/g)).toHaveLength(1);
  });
});

function collectButtons(node: ReactNode): React.ReactElement<{ className?: string; onClick?: (event: never) => void }>[] {
  if (Array.isArray(node)) return node.flatMap(collectButtons);
  if (!isValidElement<{ className?: string; onClick?: (event: never) => void; children?: ReactNode }>(node)) return [];
  const children = collectButtons(node.props.children);
  return node.type === "button" ? [node, ...children] : children;
}

function buttonClass(html: string, label: string): string | undefined {
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([markup]) => markup)
    .find((markup) => markup.replace(/<[^>]*>/g, "") === label);
  return button?.match(/class="([^"]*)"/)?.[1];
}

function createScene(): SceneSnapshot {
  const now = "2026-09-03T08:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "装配车间",
    camera: { position: { x: 8, y: 6, z: 8 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    environment: { gridVisible: true, backgroundColor: "#16252c", skybox: "none" },
    models: [],
    primitives: [{ modelId: "box-1", name: "工位", kind: "box", color: "#2878c7", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    measurements: [],
    annotations: [],
    createdAt: now,
    updatedAt: now,
  };
}
