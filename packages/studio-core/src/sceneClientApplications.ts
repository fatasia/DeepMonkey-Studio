import { migrateSceneSnapshotV1, resolveSceneScriptProtocolCompatibility, type ApplicationDocument, type SceneSnapshot, type SceneInteractionActionState } from "@bim-studio/contracts";

export interface SceneClientApplicationSelection {
  applications: ApplicationDocument[];
  unresolved: Array<{ applicationId: string; path: string; reason: string }>;
}

/** 仅追踪合同内显式引用。脚本存在时保留关联应用完整内容，并交调用方阻断发布。 */
export function selectSceneClientApplications(scene: SceneSnapshot, applications: readonly ApplicationDocument[]): SceneClientApplicationSelection {
  const result: SceneClientApplicationSelection = { applications: [], unresolved: [] };
  const roots = new Set([scene.id]), pageRoots = new Set<string>();
  const fail = (path: string, detail: string): never => { throw new Error(`客户端应用依赖 ${path}：${detail}`); };
  const actions = (values: readonly SceneInteractionActionState[], addScene: (id: string, path: string) => void,
    addPage: (id: string, path: string) => void, path: string) => {
    values.forEach((action, index) => {
      if (!action.enabled) return;
      const at = `${path}[${index}]`;
      if (action.type === "navigateScene") action.sceneId ? addScene(action.sceneId, `${at}.sceneId`) : fail(at, "跳转场景缺失");
      if (action.dashboardPageId) addPage(action.dashboardPageId, `${at}.dashboardPageId`);
    });
  };
  for (const [index, script] of (scene.interactions ?? []).entries()) if (script.enabled) {
    actions(script.actions ?? [], id => { roots.add(id); }, id => { pageRoots.add(id); }, `scene.interactions[${index}].actions`);
  }
  const appIds = new Set<string>();
  for (const app of applications) {
    if (!app.metadata.id || appIds.has(app.metadata.id)) fail("applications.metadata.id", "应用 ID 缺失或重复");
    appIds.add(app.metadata.id);
  }
  for (const pageId of pageRoots) {
    const owners = applications.filter(app => app.pages.some(page => page.id === pageId));
    if (owners.length !== 1) fail(`scene.actions.dashboardPageId(${pageId})`, "页面缺失或跨应用歧义");
  }
  for (const id of roots) if (id !== scene.id) {
    const owners = applications.filter(app => app.scenes.some(value => value.id === id));
    if (owners.length !== 1) fail(`scene.actions.sceneId(${id})`, "场景缺失或跨应用歧义");
  }
  for (const input of applications) {
    // app.scenes 是应用内部缓存，不代表该应用拥有或发布这个场景；仅显式来源、
    // 视口和页面动作能建立交付关联，避免把历史测试应用一并拖入客户端闭包。
    const related = (input.metadata.source && roots.has(input.metadata.source.sceneId))
      || input.pages.some(page => pageRoots.has(page.id) || page.nodes.some(node => node.kind === "scene-viewport" && roots.has(node.sceneId)));
    if (!related) continue;
    const app = structuredClone(input), prefix = `applications[${app.metadata.id}]`;
    if (app.metadata.projectId !== scene.projectId || app.assets.some(asset => asset.projectId !== scene.projectId)) fail(prefix, "引用跨项目");
    // 保存结果是根场景唯一来源；引用校验与闭包必须先面对该版本，不能在导出时再替换。
    const rootDocument = migrateSceneSnapshotV1(scene).scenes[0]!;
    app.scenes = app.scenes.map(value => value.id === scene.id ? structuredClone(rootDocument) : value);
    if (!app.scenes.some(value => value.id === scene.id) && (app.metadata.source?.sceneId === scene.id
      || app.pages.some(page => page.nodes.some(node => node.kind === "scene-viewport" && node.sceneId === scene.id)))) {
      app.scenes.push(rootDocument);
    };
    const unique = <T,>(values: readonly T[], id: (value: T) => string, path: string): Map<string, T> => {
      const map = new Map<string, T>();
      for (const value of values) { const key = id(value); if (!key || map.has(key)) fail(path, "ID 缺失或重复"); map.set(key, value); }
      return map;
    };
    const pages = unique(app.pages, page => page.id, `${prefix}.pages`);
    const scenes = unique(app.scenes, value => value.id, `${prefix}.scenes`);
    for (const page of app.pages) for (const node of page.nodes) {
      if (node.kind === "scene-viewport" && !scenes.has(node.sceneId)) fail(`${prefix}.pages[${page.id}].nodes[${node.id}].sceneId`, "场景不存在");
    }
    const widgets = unique(app.pages.flatMap(page => page.nodes.map(node => ({ node, pageId: page.id }))), value => value.node.id, `${prefix}.widgets`);
    unique(app.interactions, flow => flow.id, `${prefix}.interactions`);
    const selectedPages = new Set<string>(), selectedScenes = new Set<string>();
    const navigationPages = new Set<string>(), navigationScenes = new Set<string>();
    const addPage = (id: string, path: string, ancestorOnly = false) => { if (!pages.has(id)) fail(path, `页面不存在：${id}`); selectedPages.add(id); if (!ancestorOnly) navigationPages.add(id); };
    const addScene = (id: string, path: string, ancestorOnly = false) => { if (!scenes.has(id)) fail(path, `场景不存在：${id}`); selectedScenes.add(id); if (!ancestorOnly) navigationScenes.add(id); };
    for (const id of roots) if (scenes.has(id)) addScene(id, prefix);
    for (const page of app.pages) if (pageRoots.has(page.id) || page.nodes.some(node => node.kind === "scene-viewport" && roots.has(node.sceneId))) addPage(page.id, prefix);
    if (app.metadata.source) addScene(app.metadata.source.sceneId, `${prefix}.metadata.source.sceneId`, !roots.has(app.metadata.source.sceneId));
    const unresolved = (path: string) => result.unresolved.push({ applicationId: app.metadata.id, path, reason: "脚本运行协议不受离线客户端支持；请迁移到 Worker Sandbox 或停用该脚本。" });
    for (const [index, script] of app.scripts.entries()) if (script.enabled && script.code.trim()) {
      // 与 SDK 共享协议判定；host 的 sceneCommandPolicy 拒绝无 scene.write 的命令。
      const resolved = resolveSceneScriptProtocolCompatibility(script);
      // scene.write 只操作已冻结场景中的稳定对象句柄，不会扩大客户端依赖闭包。
      // 数据、网络等外部依赖由 sceneClientRuntimeDependencies 按显式合同继续严格校验。
      if (resolved.status !== "ready") unresolved(`${prefix}.scripts[${index}]`);
    }
    for (const [index, script] of (scene.interactions ?? []).entries()) if (script.enabled && script.code.trim()) unresolved(`scene.interactions[${index}]`);
    for (const [index, flow] of app.interactions.entries()) if (flow.enabled && flow.legacyScript?.script.enabled && flow.legacyScript.script.code.trim()) unresolved(`${prefix}.interactions[${index}].legacyScript`);
    const dynamic = result.unresolved.some(issue => issue.applicationId === app.metadata.id);
    if (dynamic) { for (const id of pages.keys()) addPage(id, prefix); for (const id of scenes.keys()) addScene(id, prefix); }
    const nodes = unique(app.spatialNavigation?.nodes ?? [], node => node.id, `${prefix}.spatialNavigation.nodes`);
    // 活动分支保留后代；祖先仅用于路径和场景继承，不把它的其他分支拉入包。
    for (const [id, node] of nodes) {
      if (node.parentId && !nodes.has(node.parentId)) fail(`${prefix}.spatialNavigation.${id}.parentId`, "父节点不存在");
    }
    const spatial = new Set<string>(), activeSpatial = new Set<string>();
    for (const id of app.spatialNavigation?.rootNodeIds ?? []) {
      if (!nodes.has(id)) fail(`${prefix}.spatialNavigation.rootNodeIds`, `节点不存在：${id}`);
    }
    const sourceExists = (flow: ApplicationDocument["interactions"][number]) => {
      const ref = flow.source;
      if (ref.kind === "page") return pages.has(ref.id);
      if (ref.kind === "widget") return widgets.has(ref.id);
      if (ref.kind === "scene") return scenes.has(ref.id);
      const source = scenes.get(ref.sceneId);
      return Boolean(source && [...source.models, ...source.primitives].some(value => value.modelId === ref.modelId));
    };
    const relevant = (flow: ApplicationDocument["interactions"][number]) => {
      if (!sourceExists(flow)) return false;
      const ref = flow.source;
      if (ref.kind === "page") return selectedPages.has(ref.id);
      if (ref.kind === "widget") return selectedPages.has(widgets.get(ref.id)?.pageId ?? "");
      return selectedScenes.has(ref.kind === "scene" ? ref.id : ref.sceneId);
    }
    let changed = true;
    while (changed) {
      const count = () => selectedPages.size + selectedScenes.size + spatial.size + activeSpatial.size + navigationPages.size + navigationScenes.size;
      const before = count();
      for (const id of selectedPages) for (const node of pages.get(id)!.nodes) if (node.kind === "scene-viewport") addScene(node.sceneId, `${prefix}.pages[${id}].nodes[${node.id}].sceneId`, !navigationPages.has(id));
      for (const [id, node] of nodes) {
        if (dynamic || (node.sceneId && navigationScenes.has(node.sceneId)) || (node.dashboardPageId && navigationPages.has(node.dashboardPageId)) || (node.parentId && activeSpatial.has(node.parentId))) activeSpatial.add(id);
        if (activeSpatial.has(id)) spatial.add(id);
        if (!spatial.has(id)) continue;
        if (node.parentId) spatial.add(node.parentId);
        if (node.sceneId) addScene(node.sceneId, `${prefix}.spatialNavigation[${id}].sceneId`, !activeSpatial.has(id));
        // dashboardPageId 是空间节点的可选伴随页面。历史应用可能在删除页面后留下旧引用；
        // 场景客户端仍可保留 3D 导航节点，但不能把不存在的页面写入离线闭包。
        if (node.dashboardPageId && pages.has(node.dashboardPageId)) addPage(node.dashboardPageId, `${prefix}.spatialNavigation[${id}].dashboardPageId`, !activeSpatial.has(id));
      }
      for (const [index, flow] of app.interactions.entries()) if (flow.enabled && relevant(flow)) actions(flow.actions, addScene, addPage, `${prefix}.interactions[${index}].actions`);
      changed = before !== count();
    }
    app.pages = app.pages.filter(page => selectedPages.has(page.id));
    app.scenes = app.scenes.filter(value => selectedScenes.has(value.id));
    app.interactions = app.interactions.filter(flow => relevant(flow));
    app.publicationProfiles = app.publicationProfiles.filter(profile => selectedPages.has(profile.entryPageId));
    if (app.spatialNavigation) {
      app.spatialNavigation.nodes = app.spatialNavigation.nodes.filter(node => spatial.has(node.id)).map(node => {
        if (!node.dashboardPageId || pages.has(node.dashboardPageId)) return node;
        const { dashboardPageId: _danglingPage, ...sceneOnlyNode } = node;
        return sceneOnlyNode;
      });
      app.spatialNavigation.rootNodeIds = app.spatialNavigation.rootNodeIds.filter(id => spatial.has(id));
    }
    result.applications.push(app);
  }
  if (!result.applications.length) for (const [index, script] of (scene.interactions ?? []).entries()) {
    if (script.enabled && script.code.trim()) result.unresolved.push({ applicationId: scene.id, path: `scene.interactions[${index}]`, reason: "脚本缺少可枚举的客户端依赖声明；请停用该脚本或选择仅发布。" });
  }
  return result;
}
