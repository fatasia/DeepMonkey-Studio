import type { ApplicationDocument, ApplicationObjectRef } from "./application.js";

/** 仅校验源文档内的显式引用；外部资源、脚本命令和模型内部层级留给编译依赖解析。 */
export function assertDashboardDocumentReferences(application: ApplicationDocument, pages: ReadonlySet<string>, widgets: ReadonlySet<string>): void {
  const scenes = new Map(application.scenes.map(scene => [scene.id, scene]));
  if (scenes.size !== application.scenes.length) throw new Error("DashboardDocument 场景 ID 重复");
  for (const scene of scenes.values()) {
    const ids = new Set<string>();
    for (const object of [...scene.models, ...scene.primitives]) {
      if (!object.modelId || ids.has(object.modelId)) throw new Error(`DashboardDocument 场景对象 ID 缺失或重复：${scene.id}/${object.modelId}`);
      ids.add(object.modelId);
    }
    const cameras = new Set((scene.cameraViews ?? []).map(view => view.id));
    if (cameras.size !== (scene.cameraViews ?? []).length) throw new Error(`DashboardDocument 相机视图 ID 重复：${scene.id}`);
  }
  const requireScene = (id: string, path: string) => {
    const scene = scenes.get(id);
    if (!scene) throw new Error(`${path} 引用的场景不存在：${id}`);
    return scene;
  };
  for (const page of application.pages) for (const node of page.nodes) {
    if (node.kind !== "scene-viewport") continue;
    const path = `DashboardDocument 页面 ${page.id} 节点 ${node.id}`;
    const scene = requireScene(node.sceneId, path);
    if (node.cameraViewId && !(scene.cameraViews ?? []).some(view => view.id === node.cameraViewId)) {
      throw new Error(`${path} 引用的相机视图不存在：${node.cameraViewId}`);
    }
  }
  const checkObject = (ref: ApplicationObjectRef, path: string) => {
    if (ref.kind === "page" && !pages.has(ref.id)) throw new Error(`${path} 引用的页面不存在：${ref.id}`);
    if (ref.kind === "widget" && !widgets.has(ref.id)) throw new Error(`${path} 引用的节点不存在：${ref.id}`);
    if (ref.kind === "scene") requireScene(ref.id, path);
    if (ref.kind === "object") {
      const scene = requireScene(ref.sceneId, path);
      if (![...scene.models, ...scene.primitives].some(object => object.modelId === ref.modelId)) {
        throw new Error(`${path} 引用的场景对象不存在：${ref.sceneId}/${ref.modelId}`);
      }
    }
  };
  for (const flow of application.interactions) checkObject(flow.source, `DashboardDocument 交互 ${flow.id}`);
  for (const profile of application.publicationProfiles) {
    if (!pages.has(profile.entryPageId)) throw new Error(`DashboardDocument 发布配置 ${profile.id} 引用的页面不存在：${profile.entryPageId}`);
  }
  for (const node of application.spatialNavigation?.nodes ?? []) {
    if (node.sceneId) requireScene(node.sceneId, `DashboardDocument 空间节点 ${node.id}`);
    if (node.dashboardPageId && !pages.has(node.dashboardPageId)) throw new Error(`DashboardDocument 空间节点 ${node.id} 引用的页面不存在：${node.dashboardPageId}`);
  }
}
