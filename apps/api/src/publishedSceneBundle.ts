import { getSceneModelAssetId, type ProjectRecord, type PublishedSceneRecord } from "@bim-studio/contracts";

export interface PublishedSceneBrowseRecord {
  publication: PublishedSceneRecord;
  project: ProjectRecord;
}

/**
 * 公开浏览只暴露渲染当前快照所需的项目骨架，避免把数据源、AI 绑定和运维配置
 * 一并带到匿名发布边界。模型二进制仍由公开的 /assets 路由读取。
 */
export function createPublishedSceneBrowseRecord(
  publication: PublishedSceneRecord,
  project: ProjectRecord,
): PublishedSceneBrowseRecord {
  if (publication.projectId !== project.id) {
    throw new Error("发布快照与项目不匹配");
  }
  const modelIds = new Set(publication.snapshot.models.map(getSceneModelAssetId));
  const serializedScene = JSON.stringify(publication.snapshot);
  const assets = project.assets?.filter((asset) => serializedScene.includes(asset.url));
  return {
    publication: structuredClone(publication),
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      models: project.models.filter((model) => modelIds.has(model.id)).map((model) => structuredClone(model)),
      ...(assets?.length ? { assets: assets.map((asset) => structuredClone(asset)) } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
  };
}
