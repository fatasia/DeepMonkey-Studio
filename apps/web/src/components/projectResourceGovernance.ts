import type {
  ApplicationDocument,
  DashboardDataWidgetConfig,
  ProjectRecord,
  SceneModelState,
  SceneSnapshot,
} from "@bim-studio/contracts";

export type GovernedResourceKind = "model" | "media" | "unity";

export interface ResourceReference {
  id: string;
  applicationName: string;
  location: string;
  overrideCount: number;
  versionId?: string;
}

export interface GovernedResource {
  key: string;
  id: string;
  kind: GovernedResourceKind;
  name: string;
  versionLabel: string;
  versionCount: number;
  activeVersionId?: string;
  references: ResourceReference[];
  instanceCount: number;
  overrideCount: number;
  unused: boolean;
}

export interface MissingResourceDependency {
  key: string;
  resourceId: string;
  kind: GovernedResourceKind | "unity-version";
  location: string;
}

export interface ProjectResourceGovernanceReport {
  resources: GovernedResource[];
  missingDependencies: MissingResourceDependency[];
  definitionCount: number;
  versionCount: number;
  instanceCount: number;
  overrideCount: number;
  unusedCount: number;
}

/**
 * 在现有项目资源上建立轻量的 Definition → Version → Instance Override 视图。
 * 不复制模型或引入独立 Prefab 存储，避免资源治理反过来增加运行时负担。
 */
export function analyzeProjectResourceGovernance(
  project: ProjectRecord | undefined,
  applications: readonly ApplicationDocument[],
  legacyScenes: readonly SceneSnapshot[] = [],
): ProjectResourceGovernanceReport {
  if (!project) return emptyReport();
  const resources = new Map<string, GovernedResource>();
  for (const model of project.models) {
    const revision = model.generation?.kind === "parametric" ? model.generation.revision : 1;
    addDefinition(resources, {
      key: resourceKey("model", model.id), id: model.id, kind: "model", name: model.name,
      versionLabel: `v${revision}`, versionCount: 1, references: [], instanceCount: 0, overrideCount: 0, unused: true,
    });
  }
  for (const asset of project.assets ?? []) {
    addDefinition(resources, {
      key: resourceKey("media", asset.id), id: asset.id, kind: "media", name: asset.name,
      versionLabel: "v1", versionCount: 1, references: [], instanceCount: 0, overrideCount: 0, unused: true,
    });
  }
  for (const resource of project.unityResources ?? []) {
    const active = resource.versions.find((version) => version.id === resource.activeVersionId);
    addDefinition(resources, {
      key: resourceKey("unity", resource.id), id: resource.id, kind: "unity", name: resource.name,
      versionLabel: active ? `v${active.version}` : "—", versionCount: resource.versions.length,
      activeVersionId: resource.activeVersionId, references: [], instanceCount: 0, overrideCount: 0, unused: true,
    });
  }

  const missing: MissingResourceDependency[] = [];
  const applicationSceneIds = new Set<string>();
  for (const application of applications) {
    for (const scene of application.scenes) {
      applicationSceneIds.add(scene.id);
      for (const model of scene.models) {
        addReference(resources, missing, "model", model.modelId, {
          id: `${application.metadata.id}:scene:${scene.id}:model:${model.modelId}`,
          applicationName: application.metadata.name,
          location: `${scene.name} / ${model.name}`,
          overrideCount: countModelOverrides(model),
        });
      }
      addAppearanceReferences(project, resources, missing, scene, application.metadata.name, `${application.metadata.id}:scene:${scene.id}`);
    }
    for (const page of application.pages) {
      for (const node of page.nodes) {
        if (node.kind !== "data-widget") continue;
        const location = `${page.name} / ${node.name || node.widget.title || node.id}`;
        if (node.widget.assetId) {
          addReference(resources, missing, "media", node.widget.assetId, {
            id: `${application.metadata.id}:page:${page.id}:media:${node.id}`,
            applicationName: application.metadata.name,
            location,
            overrideCount: 0,
          });
        }
        if (node.widget.unityResourceId) {
          addReference(resources, missing, "unity", node.widget.unityResourceId, {
            id: `${application.metadata.id}:page:${page.id}:unity:${node.id}`,
            applicationName: application.metadata.name,
            location,
            overrideCount: countUnityOverrides(node.widget),
            ...(node.widget.unityResourceVersionId ? { versionId: node.widget.unityResourceVersionId } : {}),
          });
          validateUnityVersion(project, missing, node.widget.unityResourceId, node.widget.unityResourceVersionId, location);
        }
      }
    }
  }

  // 未迁入应用文档的旧场景仍纳入引用统计，避免误报为可清理资源。
  for (const scene of legacyScenes) {
    if (applicationSceneIds.has(scene.id)) continue;
    for (const model of scene.models) {
      addReference(resources, missing, "model", model.modelId, {
        id: `legacy:scene:${scene.id}:model:${model.modelId}`,
        applicationName: "Legacy",
        location: `${scene.name} / ${model.name}`,
        overrideCount: countModelOverrides(model),
      });
    }
    addAppearanceReferences(project, resources, missing, scene, "Legacy", `legacy:scene:${scene.id}`);
  }

  const list = [...resources.values()]
    .map((resource) => ({
      ...resource,
      instanceCount: resource.references.length,
      overrideCount: resource.references.reduce((total, reference) => total + reference.overrideCount, 0),
      unused: resource.references.length === 0,
    }))
    .sort((left, right) => Number(right.unused) - Number(left.unused) || left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
  return {
    resources: list,
    missingDependencies: dedupeMissing(missing),
    definitionCount: list.length,
    versionCount: list.reduce((total, resource) => total + resource.versionCount, 0),
    instanceCount: list.reduce((total, resource) => total + resource.instanceCount, 0),
    overrideCount: list.reduce((total, resource) => total + resource.overrideCount, 0),
    unusedCount: list.filter((resource) => resource.unused).length,
  };
}

function addAppearanceReferences(
  project: ProjectRecord,
  resources: Map<string, GovernedResource>,
  missing: MissingResourceDependency[],
  scene: Pick<SceneSnapshot, "id" | "name" | "models" | "environment">,
  applicationName: string,
  referencePrefix: string,
): void {
  const assetIdByUrl = new Map((project.assets ?? []).flatMap((asset) => [asset.url, ...(asset.maps ?? []).map((map) => map.url)].map((url) => [url, asset.id] as const)));
  const environmentAssetId = scene.environment?.environmentMapUrl ? assetIdByUrl.get(scene.environment.environmentMapUrl) : undefined;
  if (environmentAssetId) {
    addReference(resources, missing, "media", environmentAssetId, {
      id: `${referencePrefix}:environment:${environmentAssetId}`,
      applicationName,
      location: `${scene.name} / 场景环境`,
      overrideCount: 1,
    });
  }
  for (const model of scene.models) {
    const textureUrls = [...materialUrls(model.material), ...(model.layers ?? []).flatMap((layer) => materialUrls(layer.material))];
    const referencedAssetIds = new Set(textureUrls.flatMap((url) => assetIdByUrl.get(url) ?? []));
    for (const assetId of referencedAssetIds) {
      addReference(resources, missing, "media", assetId, {
        id: `${referencePrefix}:model:${model.modelId}:appearance:${assetId}`,
        applicationName,
        location: `${scene.name} / ${model.name} / 材质`,
        overrideCount: 1,
      });
    }
  }
}

function materialUrls(material: SceneModelState["material"]): string[] {
  if (!material) return [];
  return [material.baseColorMapUrl, material.normalMapUrl, material.emissiveMapUrl, material.ambientOcclusionMapUrl, material.roughnessMapUrl, material.metalnessMapUrl]
    .filter((url): url is string => Boolean(url));
}

function addDefinition(resources: Map<string, GovernedResource>, resource: GovernedResource): void {
  resources.set(resource.key, resource);
}

function addReference(
  resources: Map<string, GovernedResource>,
  missing: MissingResourceDependency[],
  kind: GovernedResourceKind,
  resourceId: string,
  reference: ResourceReference,
): void {
  const resource = resources.get(resourceKey(kind, resourceId));
  if (!resource) {
    missing.push({ key: `${kind}:${resourceId}:${reference.id}`, resourceId, kind, location: reference.location });
    return;
  }
  if (!resource.references.some((candidate) => candidate.id === reference.id)) resource.references.push(reference);
}

function validateUnityVersion(
  project: ProjectRecord,
  missing: MissingResourceDependency[],
  resourceId: string,
  versionId: string | undefined,
  location: string,
): void {
  if (!versionId) return;
  const resource = project.unityResources?.find((candidate) => candidate.id === resourceId);
  if (resource && !resource.versions.some((version) => version.id === versionId)) {
    missing.push({ key: `unity-version:${resourceId}:${versionId}:${location}`, resourceId: versionId, kind: "unity-version", location });
  }
}

function countModelOverrides(model: SceneModelState): number {
  let count = 0;
  if (!model.visible) count += 1;
  if (model.locked) count += 1;
  if (model.opacity !== 1) count += 1;
  if (model.colorOverride || model.material) count += 1;
  if (!isIdentityTransform(model.transform)) count += 1;
  if (model.effects || model.layers?.length) count += 1;
  if (model.physics || model.rig || model.animationEnabled || model.collisionEnabled) count += 1;
  return count;
}

function countUnityOverrides(widget: DashboardDataWidgetConfig): number {
  return Object.keys(widget.unityPropertyValues ?? {}).length
    + (widget.unityDataBindings?.length ?? 0)
    + Number(Boolean(widget.unityScene))
    + Number(Boolean(widget.unityDefaultAction));
}

function isIdentityTransform(transform: SceneModelState["transform"]): boolean {
  const zero = (value: { x: number; y: number; z: number }) => value.x === 0 && value.y === 0 && value.z === 0;
  return zero(transform.position) && zero(transform.rotation) && transform.scale.x === 1 && transform.scale.y === 1 && transform.scale.z === 1;
}

function resourceKey(kind: GovernedResourceKind, id: string): string {
  return `${kind}:${id}`;
}

function dedupeMissing(items: MissingResourceDependency[]): MissingResourceDependency[] {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}

function emptyReport(): ProjectResourceGovernanceReport {
  return { resources: [], missingDependencies: [], definitionCount: 0, versionCount: 0, instanceCount: 0, overrideCount: 0, unusedCount: 0 };
}
