import type { ApplicationDocument, DashboardPageDocument, ScriptModule } from "@bim-studio/contracts";
import { resolveSceneBehaviorModule } from "./scriptModuleAdapter";

export type AuthorBehaviorScope = "current" | "enabled";

/** The latest file is overlaid only onto a disposable copy, never the author store. */
export function authorBehaviorDocument(source: ApplicationDocument, draft: ScriptModule | undefined, scope: AuthorBehaviorScope, context: { pageId?: string; sceneId?: string }) {
  const document = structuredClone(source);
  const scripts = draft ? [...document.scripts.filter(script => script.id !== draft.id), structuredClone(draft)] : document.scripts;
  if (scope === "current" && !draft) throw new Error("请先选择要试运行的脚本");
  document.scripts = scope === "current" ? [structuredClone(draft!)] : scripts;
  const resolved = document.scripts.map(script => resolveSceneBehaviorModule(script));
  if (scope === "current" && resolved[0]?.status !== "ready") throw new Error(resolved[0]?.message ?? "当前脚本不可运行");
  if (!resolved.some(result => result.status === "ready")) throw new Error("没有可运行的已启用脚本");

  const target = scope === "current" ? draft?.target : undefined;
  let page = document.pages.find(page => page.id === context.pageId);
  if (target?.kind === "component") {
    page = document.pages.find(page => page.nodes.some(node => node.id === target.id));
    if (!page) throw new Error("脚本挂载的二维组件已不存在，请重新选择挂载对象");
  } else if (target?.kind === "object") {
    const scene = document.scenes.find(scene => [...scene.models, ...scene.primitives].some(item => item.modelId === target.id));
    if (!scene) throw new Error("脚本挂载的三维对象已不存在，请重新选择挂载对象");
    if (!page?.nodes.some(node => node.kind === "scene-viewport" && node.sceneId === scene.id && node.renderMode !== "static-placeholder")) {
      page = scenePage(scene);
      document.pages.push(page);
    }
  }
  if (!page) {
    const scene = document.scenes.find(scene => scene.id === context.sceneId) ?? document.scenes[0];
    page = scene ? scenePage(scene) : document.pages[0];
    if (page && !document.pages.includes(page)) document.pages.push(page);
  }
  if (!page) throw new Error("当前应用没有可用于试运行的页面或场景");
  return { document, pageId: page.id };
}

function scenePage(scene: ApplicationDocument["scenes"][number]): DashboardPageDocument {
  return { id: `author-test:${scene.id}`, name: scene.name, width: 1280, height: 800, viewportFit: "contain", nodes: [{
    id: `author-test-viewport:${scene.id}`, name: scene.name, kind: "scene-viewport", zIndex: 0,
    frame: { x: 0, y: 0, width: 1280, height: 800 }, sceneId: scene.id,
    renderMode: "realtime", interactionPolicy: "click-select", overlaySlot: "page",
  }] };
}
