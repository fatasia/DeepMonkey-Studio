import type { AppRoute } from "../appRoute";

/** A typed local destination, never a caller-supplied redirect URL. */
export interface ModelAssetReturn { sceneId: string; applicationId?: string }
const identity = (value: string | null): string | undefined => value && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : undefined;

export function readModelAssetQuery(query: URLSearchParams, scene = false): Partial<AppRoute> {
  if (scene) {
    const insertModelId = identity(query.get("addModel"));
    return insertModelId ? { insertModelId } : {};
  }
  const modelId = identity(query.get("model"));
  const sceneId = identity(query.get("returnScene"));
  const applicationId = identity(query.get("returnApplication"));
  return {
    ...(modelId ? { modelId } : {}),
    ...(query.get("scope") === "project" ? { assetScope: "project" } : {}),
    ...(identity(query.get("project")) && sceneId ? { assetReturn: { sceneId, ...(applicationId ? { applicationId } : {}) } } : {}),
  };
}

export function writeModelAssetQuery(query: URLSearchParams, route: AppRoute): void {
  if (route.modelId) query.set("model", route.modelId);
  if (route.assetScope === "project") query.set("scope", "project");
  if (route.projectId && route.assetReturn) {
    query.set("returnScene", route.assetReturn.sceneId);
    if (route.assetReturn.applicationId) query.set("returnApplication", route.assetReturn.applicationId);
  }
}

export function modelAssetLibraryRoute(projectId?: string, modelId?: string, assetReturn?: ModelAssetReturn): AppRoute {
  return { view: "manager", managerTab: "assets", assetScope: "project", ...(projectId ? { projectId } : {}), ...(modelId ? { modelId } : {}), ...(assetReturn ? { assetReturn } : {}) };
}

export function modelAssetSceneRoute(projectId: string, destination: ModelAssetReturn, insertModelId?: string): AppRoute {
  return { view: "studio", projectId, sceneId: destination.sceneId, ...(destination.applicationId ? { applicationId: destination.applicationId } : {}), ...(insertModelId ? { insertModelId } : {}) };
}

export function appendSceneAssetQuery(path: string, route: AppRoute): string {
  const query = new URLSearchParams();
  if (route.projectId && !route.applicationId) query.set("project", route.projectId);
  if (route.insertModelId) query.set("addModel", route.insertModelId);
  return `${path}${query.size ? `?${query.toString()}` : ""}`;
}
