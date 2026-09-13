import type {
  ModelRecord,
  ModelProcessingRecord,
  ParametricModelGeneration,
  ProjectAssetRecord,
  ProjectRecord,
  PublishedSceneRecord,
  RevitRuntimeInfo,
  RvtConversionMode,
  SceneSnapshot,
} from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/** 工程模型、素材和场景版本接口。BIM 在这里保持资产底座角色。 */
export function createModelSceneApi(request: ApiRequest) {
  return {
    saveResourceThumbnail: (projectId: string, kind: "models" | "assets", resourceId: string, file: Blob) => {
      const body = new FormData();
      body.append("file", file, "thumbnail.webp");
      return request<ModelRecord | ProjectAssetRecord>(`/api/projects/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(resourceId)}/thumbnail`, { method: "POST", body });
    },
    uploadOptimizedModel: (projectId: string, file: File, sourceModelId?: string, processing?: ModelProcessingRecord) => {
      const data = new FormData();
      if (processing) data.append("processing", JSON.stringify(processing));
      data.append("file", file);
      const query = sourceModelId ? `?optimizedFromModelId=${encodeURIComponent(sourceModelId)}` : "";
      return request<ModelRecord>(`/api/projects/${projectId}/models${query}`, { method: "POST", body: data });
    },
    listRevitInstallations: () =>
      request<RevitRuntimeInfo>("/api/revit/installations"),
    uploadModel: async (
      projectId: string,
      file: File,
      rvtConversionMode: RvtConversionMode = "native-glb",
      rvtRevitVersion = "auto",
      generation?: ParametricModelGeneration,
      robotEntryPath?: string,
    ) => {
      const data = new FormData();
      // multipart 字段必须位于文件前，服务端才能在开始持久化前完成生成元数据校验。
      if (generation) data.append("generation", JSON.stringify(generation));
      if (robotEntryPath) data.append("robotEntryPath", robotEntryPath);
      data.append("file", file);
      return request<ModelRecord>(
        `/api/projects/${projectId}/models?rvtConversionMode=${encodeURIComponent(rvtConversionMode)}&rvtRevitVersion=${encodeURIComponent(rvtRevitVersion)}`,
        { method: "POST", body: data },
      );
    },
    renameModel: (projectId: string, modelId: string, name: string) =>
      request<ModelRecord>(`/api/projects/${projectId}/models/${modelId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    listAssets: (projectId: string) =>
      request<ProjectAssetRecord[]>(`/api/projects/${projectId}/assets`),
    uploadImageAsset: async (projectId: string, file: File) => {
      const data = new FormData();
      data.append("file", file);
      return request<ProjectAssetRecord>(
        `/api/projects/${projectId}/assets/images`,
        {
          method: "POST",
          body: data,
        },
      );
    },
    uploadVideoAsset: async (projectId: string, file: File) => {
      const data = new FormData();
      data.append("file", file);
      return request<ProjectAssetRecord>(
        `/api/projects/${projectId}/assets/videos`,
        {
          method: "POST",
          body: data,
        },
      );
    },
    renameAsset: (projectId: string, assetId: string, name: string) =>
      request<ProjectAssetRecord>(
        `/api/projects/${projectId}/assets/${assetId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      ),
    deleteAsset: (projectId: string, assetId: string) =>
      request<void>(`/api/projects/${projectId}/assets/${assetId}`, {
        method: "DELETE",
      }),
    uploadEnvironmentMap: async (projectId: string, file: File) => {
      const data = new FormData();
      data.append("file", file);
      return request<ProjectAssetRecord>(
        `/api/projects/${projectId}/environment-maps`,
        { method: "POST", body: data },
      );
    },
    uploadMaterialAsset: async (projectId: string, maps: Partial<Record<"base-color" | "normal" | "roughness" | "metalness" | "ao", File>>) => {
      const data = new FormData();
      for (const [kind, file] of Object.entries(maps)) if (file) data.append(kind, file);
      return request<ProjectAssetRecord>(`/api/projects/${projectId}/assets/materials`, { method: "POST", body: data });
    },
    deleteModel: (projectId: string, modelId: string) =>
      request<void>(`/api/projects/${projectId}/models/${modelId}`, {
        method: "DELETE",
      }),
    listScenes: (projectId: string, options: { signal?: AbortSignal } = {}) =>
      request<SceneSnapshot[]>(`/api/projects/${projectId}/scenes`, options),
    saveScene: (scene: SceneSnapshot) =>
      request<SceneSnapshot>(
        `/api/projects/${scene.projectId}/scenes/${scene.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(scene),
        },
      ),
    importScene: (projectId: string, scene: SceneSnapshot) =>
      request<SceneSnapshot>(`/api/projects/${projectId}/scenes/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scene),
      }),
    copyScene: (projectId: string, sceneId: string, name?: string) =>
      request<SceneSnapshot>(
        `/api/projects/${projectId}/scenes/${sceneId}/copy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(name ? { name } : {}),
        },
      ),
    renameScene: (projectId: string, sceneId: string, name: string) =>
      request<SceneSnapshot>(`/api/projects/${projectId}/scenes/${sceneId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    publishScene: (projectId: string, sceneId: string) =>
      request<PublishedSceneRecord>(
        `/api/projects/${projectId}/scenes/${sceneId}/publish`,
        {
          method: "POST",
        },
      ),
    listScenePublications: (projectId: string, sceneId: string) =>
      request<PublishedSceneRecord[]>(
        `/api/projects/${projectId}/scenes/${sceneId}/publications`,
      ),
    restoreScenePublication: (
      projectId: string,
      sceneId: string,
      publishedAt: string,
    ) =>
      request<PublishedSceneRecord>(
        `/api/projects/${projectId}/scenes/${sceneId}/publications/${encodeURIComponent(publishedAt)}/restore`,
        { method: "POST" },
      ),
    unpublishScene: (projectId: string, sceneId: string) =>
      request<void>(`/api/projects/${projectId}/scenes/${sceneId}/publish`, {
        method: "DELETE",
      }),
    getPublishedScene: (sceneId: string) =>
      request<PublishedSceneRecord>(`/api/public/scenes/${sceneId}`),
    getPublishedSceneForBrowse: (sceneId: string) =>
      request<{ publication: PublishedSceneRecord; project: ProjectRecord }>(
        `/api/public/scenes/${sceneId}/browse`,
      ),
    getSceneForBrowse: (sceneId: string) =>
      request<{ scene: SceneSnapshot; project: ProjectRecord }>(
        `/api/scenes/${sceneId}/browse`,
      ),
    deleteScene: (projectId: string, sceneId: string) =>
      request<void>(`/api/projects/${projectId}/scenes/${sceneId}`, {
        method: "DELETE",
      }),
  };
}
