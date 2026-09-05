import type { ApplicationDocument, SceneInteractionActionState } from "@bim-studio/contracts";

export function publishedApplicationId(pathname: string): string | undefined {
  const match = /^\/apps\/([^/]+)\/?$/.exec(pathname);
  if (!match) return;
  try {
    const id = decodeURIComponent(match[1]!);
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

export function publishedEntryPage(application: ApplicationDocument) {
  const profile = application.publicationProfiles.find(profile => profile.target === "browser-preview");
  return application.pages.find(page => page.id === profile?.entryPageId) ?? application.pages[0];
}

export function publicApplicationAction(application: ApplicationDocument, action: SceneInteractionActionState, origin: string): { pageId: string } | { url: string } | { message: string } | undefined {
  if (action.type === "dashboard" || action.type === "navigateScene") {
    const page = action.type === "dashboard"
      ? application.pages.find(page => page.id === action.dashboardPageId)
      : application.pages.find(page => page.nodes.some(node => node.kind === "scene-viewport" && node.sceneId === action.sceneId));
    return page ? { pageId: page.id } : { message: "目标页面未包含在此发布版本中。" };
  }
  if (action.type === "openUrl") {
    try {
      const url = new URL(String(action.url ?? ""), origin);
      if (action.url && ["https:", "http:"].includes(url.protocol)) return { url: url.href };
    } catch { /* Invalid author links receive visible feedback. */ }
    return { message: "此链接不是有效的 HTTP(S) 地址。" };
  }
  if (action.type === "message") return { message: String(action.value ?? "") };
}
