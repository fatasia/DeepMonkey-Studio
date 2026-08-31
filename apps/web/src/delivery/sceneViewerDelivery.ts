import type {
  ProjectRecord,
  PublishedSceneRecord,
  SystemBrandingSettings,
  SystemUserRecord,
} from "@bim-studio/contracts";

export const SCENE_VIEWER_API_ORIGIN = "https://scene-viewer.invalid";

export interface SceneViewerAssetEntry {
  originalUrl: string;
  localUrl: string;
  sha256: string;
  bytes: number;
}

export interface SceneViewerDeliveryManifest {
  kind: "industrial-studio-scene-viewer";
  schemaVersion: 1;
  deliveryTarget: "windows-scene-viewer";
  packageId: string;
  createdAt: string;
  publishedAt: string;
  rendererMode: "webgl" | "webgpu-preferred";
  toolbarVisible: boolean;
  sourcePublicationSha256: string;
  publicationSha256: string;
  projectSha256: string;
  publication: PublishedSceneRecord;
  project: ProjectRecord;
  branding: SystemBrandingSettings;
  assets: SceneViewerAssetEntry[];
}

let activeManifest: SceneViewerDeliveryManifest | undefined;

export function isSceneViewerDeliveryRuntime(): boolean {
  return Boolean(activeManifest);
}

export function sceneViewerDeliveryManifest(): SceneViewerDeliveryManifest | undefined {
  return activeManifest;
}

export function sceneViewerDeliveryRoute(): { view: "published"; sceneId: string } | undefined {
  return activeManifest
    ? { view: "published", sceneId: activeManifest.publication.sceneId }
    : undefined;
}

export function sceneViewerDeliveryToolbarVisible(): boolean | undefined {
  return activeManifest?.toolbarVisible;
}

export function sceneViewerDeliveryRendererMode(): "webgl" | "webgpu-preferred" | undefined {
  return activeManifest?.rendererMode;
}

export function sceneViewerDeliveryUser(): SystemUserRecord | undefined {
  if (!activeManifest) return undefined;
  return {
    id: "scene-viewer",
    username: "scene-viewer",
    displayName: "只读浏览者",
    role: "viewer",
    projectIds: [activeManifest.project.id],
    enabled: true,
    createdAt: activeManifest.createdAt,
    updatedAt: activeManifest.createdAt,
  };
}

/**
 * 只有发布器注入显式 meta 标记时才加载交付清单。标记存在但清单损坏时必须阻断，
 * 不能悄悄退回完整工作台。
 */
export async function initializeSceneViewerDelivery(
  loadManifest?: (url: URL) => Promise<unknown>,
): Promise<SceneViewerDeliveryManifest | undefined> {
  const marker = document.querySelector<HTMLMetaElement>('meta[name="scene-viewer-delivery"]');
  if (!marker?.content) return undefined;
  if (!loadManifest) throw new Error("只读场景清单缺少统一传输适配器");
  const manifest = validateManifest(await loadManifest(new URL(marker.content, window.location.href)));
  activeManifest = manifest;
  document.documentElement.dataset.deliveryTarget = manifest.deliveryTarget;
  enforceSceneViewerRoute();
  window.addEventListener("popstate", enforceSceneViewerRoute);
  return manifest;
}

export function sceneViewerDeliveryServerProfile(): { baseUrl: string } | undefined {
  return activeManifest ? { baseUrl: SCENE_VIEWER_API_ORIGIN } : undefined;
}

/** 客户端发布物只实现浏览所需 GET 合同；所有写请求和未声明 API 都会被拒绝。 */
export async function sceneViewerDeliveryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const manifest = activeManifest;
  if (!manifest) throw new Error("只读场景运行时尚未初始化");
  const url = new URL(input instanceof Request ? input.url : input.toString(), SCENE_VIEWER_API_ORIGIN);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return json({ message: "只读客户端禁止写操作" }, 405);
  const encodedSceneId = encodeURIComponent(manifest.publication.sceneId);
  const encodedProjectId = encodeURIComponent(manifest.project.id);
  if (url.pathname === `/api/public/scenes/${encodedSceneId}`) return json(manifest.publication);
  if (url.pathname === `/api/public/scenes/${encodedSceneId}/browse`) {
    return json({ publication: manifest.publication, project: manifest.project });
  }
  if (url.pathname === `/api/projects/${encodedProjectId}`) return json(manifest.project);
  if (url.pathname === "/api/projects") return json([manifest.project]);
  if (url.pathname === "/api/public/branding") return json(manifest.branding);
  if (url.pathname === "/api/revit/installations") return json({ installations: [], defaultVersion: "auto" });
  return json({ message: `只读客户端未开放接口：${url.pathname}` }, 404);
}

function enforceSceneViewerRoute(): void {
  const route = sceneViewerDeliveryRoute();
  if (!route) return;
  const expected = `/published/${encodeURIComponent(route.sceneId)}`;
  if (window.location.pathname !== expected || window.location.search || window.location.hash) {
    window.history.replaceState({}, "", expected);
  }
}

function validateManifest(value: unknown): SceneViewerDeliveryManifest {
  if (!value || typeof value !== "object") throw new Error("只读场景清单不是对象");
  const manifest = value as Partial<SceneViewerDeliveryManifest>;
  if (manifest.kind !== "industrial-studio-scene-viewer" || manifest.schemaVersion !== 1) {
    throw new Error("只读场景清单类型或版本不受支持");
  }
  if (manifest.deliveryTarget !== "windows-scene-viewer") throw new Error("交付目标不是 Windows 只读客户端");
  if (!manifest.publication || !manifest.project || manifest.publication.projectId !== manifest.project.id) {
    throw new Error("发布快照与项目资源不匹配");
  }
  if (manifest.publishedAt !== manifest.publication.publishedAt) throw new Error("发布版本时间戳不匹配");
  if (manifest.rendererMode !== "webgl" && manifest.rendererMode !== "webgpu-preferred") throw new Error("只读客户端渲染模式无效");
  if (!manifest.branding || !Array.isArray(manifest.assets)) throw new Error("只读场景清单缺少品牌或资源索引");
  return manifest as SceneViewerDeliveryManifest;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 仅供单元测试隔离模块单例。 */
export function resetSceneViewerDeliveryForTest(): void {
  activeManifest = undefined;
  delete document.documentElement.dataset.deliveryTarget;
  window.removeEventListener("popstate", enforceSceneViewerRoute);
}
