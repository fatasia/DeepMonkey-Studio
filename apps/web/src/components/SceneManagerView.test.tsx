import type { SceneSnapshot } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneManagerController } from "./SceneManager";
import { SceneManagerView } from "./SceneManagerView";

describe("SceneManagerView product surface", () => {
  it("keeps the thumbnail primary and exposes the five frequent scene actions", () => {
    const scene = createScene();
    const html = renderToStaticMarkup(<SceneManagerView controller={{
      branding: { systemName: "Industrial Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "Industrial Studio" },
      busy: false,
      cloudConfigured: false,
      cloudSceneLinks: {},
      cloudScenePolicies: {},
      isAdmin: false,
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

    expect(html).toContain("Industrial Studio");
    expect(html).toContain("scene-card-thumbnail");
    expect(html).toContain("--scene-thumbnail-color:#2878c7");
    expect(html).toContain('aria-label="预览场景"');
    expect(html).toContain('aria-label="发布场景"');
    expect(html).toContain('aria-label="复制发布链接"');
    expect(html).toContain('aria-label="重命名场景"');
    expect(html).toContain('aria-label="编辑场景"');
    expect(html).toContain('aria-label="资源"');
    expect(html).toContain('aria-label="切换语言"');
    expect(html).toContain('aria-label="退出 · 审计用户"');
    expect(html).not.toMatch(/资源库|资源中心|素材/);
  });

  it("gives topology preview cards a task-oriented accessible name", () => {
    const html = renderToStaticMarkup(<SceneManagerView controller={{
      branding: { systemName: "Industrial Studio", iconUrl: "/brand/app-icon-industrial.svg", copyright: "Industrial Studio" },
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
});

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
