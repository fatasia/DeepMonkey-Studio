import type { AppRoute } from "../appRoute";

/** A typed local destination, never a caller-supplied redirect URL. */
export interface ModelAssetReturn { sceneId: string; applicationId?: string; instanceId?: string }
const identity = (value: string | null): string | undefined => value && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : undefined;

export function readModelAssetQuery(query: URLSearchParams, scene = false): Partial<AppRoute> {
  if (scene) {
    const insertModelId = identity(query.get("addModel"));
    const replaceModelInstanceId = identity(query.get("replaceInstance"));
    return insertModelId ? { insertModelId, ...(replaceModelInstanceId ? { replaceModelInstanceId } : {}) } : {};
  }
  const modelId = identity(query.get("model"));
  const sceneId = identity(query.get("returnScene"));
  const applicationId = identity(query.get("returnApplication"));
  const instanceId = identity(query.get("returnInstance"));
  return {
    ...(modelId ? { modelId } : {}),
    ...(query.get("scope") === "project" ? { assetScope: "project" } : {}),
    ...(identity(query.get("project")) && sceneId ? { assetReturn: { sceneId, ...(applicationId ? { applicationId } : {}), ...(instanceId ? { instanceId } : {}) } } : {}),
  };
}

export function writeModelAssetQuery(query: URLSearchParams, route: AppRoute): void {
  if (route.modelId) query.set("model", route.modelId);
  if (route.assetScope === "project") query.set("scope", "project");
  if (route.projectId && route.assetReturn) {
    query.set("returnScene", route.assetReturn.sceneId);
    if (route.assetReturn.applicationId) query.set("returnApplication", route.assetReturn.applicationId);
    if (route.assetReturn.instanceId) query.set("returnInstance", route.assetReturn.instanceId);
  }
}

export function modelAssetLibraryRoute(projectId?: string, modelId?: string, assetReturn?: ModelAssetReturn): AppRoute {
  return { view: "manager", managerTab: "assets", assetScope: "project", ...(projectId ? { projectId } : {}), ...(modelId ? { modelId } : {}), ...(assetReturn ? { assetReturn } : {}) };
}

export function modelAssetOptimizerRoute(projectId?: string, modelId?: string, assetReturn?: ModelAssetReturn): AppRoute {
  return { view: "optimizer", ...(projectId ? { projectId } : {}), ...(modelId ? { modelId } : {}), ...(assetReturn ? { assetReturn } : {}) };
}

export function modelAssetSceneRoute(projectId: string, destination: ModelAssetReturn, insertModelId?: string): AppRoute {
  return { view: "studio", projectId, sceneId: destination.sceneId, ...(destination.applicationId ? { applicationId: destination.applicationId } : {}), ...(insertModelId ? { insertModelId } : {}), ...(insertModelId && destination.instanceId ? { replaceModelInstanceId: destination.instanceId } : {}) };
}

export function appendSceneAssetQuery(path: string, route: AppRoute): string {
  const query = new URLSearchParams();
  if (route.projectId && !route.applicationId) query.set("project", route.projectId);
  if (route.insertModelId) query.set("addModel", route.insertModelId);
  if (route.insertModelId && route.replaceModelInstanceId) query.set("replaceInstance", route.replaceModelInstanceId);
  return `${path}${query.size ? `?${query.toString()}` : ""}`;
}
