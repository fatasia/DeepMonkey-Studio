import { createDashboardDocument, type ProjectAssetRecord, type PublishedApplicationRecord } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";
import type { MetadataStore } from "./metadataStore.js";
import type { DashboardPublicationAuthorityRequest } from "./dashboardPublicationAuthorityAdapter.js";
import type { DashboardPublicationClosureReader } from "./dashboardNativeCandidateRuntime.js";
import type { DashboardFrozenResourceRequest, DashboardResolvedDataRequest } from "./dashboardPublicationFreeze.js";
import { dashboardSavedDataSource, readDashboardSavedData, type DashboardDataStore } from "./dashboardPublishedDataSource.js";
import type { DashboardPublishedFontCatalog } from "./dashboardPublishedFontCatalog.js";
import { dashboardDataRequestId } from "./dashboardDataRequestId.js";
export { dashboardDataRequestId } from "./dashboardDataRequestId.js";

type ClosureStore = DashboardDataStore & Pick<MetadataStore, "getProject" | "getPublishedApplication" | "listAssets">;

const dataId = dashboardDataRequestId;

/** Production closure over server-owned publications, project assets and Data Hub sources. */
export function createDashboardPublishedClosure(store: ClosureStore, config: AppConfig,
  options: { readonly fonts?: DashboardPublishedFontCatalog } = {}): DashboardPublicationClosureReader {
  function published(request: Pick<DashboardPublicationAuthorityRequest, "publicationId" | "projectId" | "applicationId" | "applicationRevision" | "entryPageId">) {
    const publication = store.getPublishedApplication(request.publicationId);
    if (!publication || !store.getProject(request.projectId) || publication.projectId !== request.projectId
      || publication.applicationId !== request.applicationId || publication.applicationRevision !== request.applicationRevision)
      throw new Error("Dashboard publication is no longer authoritative");
    return createDashboardDocument(publication.document, request.entryPageId);
  }
  function mediaRequests(publication: PublishedApplicationRecord, entryPageId: string): DashboardFrozenResourceRequest[] {
    const document = published({ ...publication, publicationId: publication.id, entryPageId });
    const assets = store.listAssets(publication.projectId);
    const requests = new Map<string, DashboardFrozenResourceRequest>();
    for (const page of document.application.pages) {
      const url = page.appearance?.backgroundImageUrl;
      if (!url) continue;
      const asset = assets.find(asset => asset.url === url);
      if (!asset) throw new Error(`Published page background has no project asset: ${page.id}`);
      const value = mediaRequest(asset, publication.projectId, [], "image");
      const existing = requests.get(value.id);
      requests.set(value.id, { ...value, pageIds: [...existing?.pageIds ?? [], page.id] });
    }
    for (const node of document.application.pages.flatMap(page => page.nodes)) {
      if (node.kind !== "data-widget" || !["image", "video"].includes(node.widget.type)) continue;
      const kind = node.widget.type as "image" | "video";
      const asset = node.widget.assetId ? assets.find(asset => asset.id === node.widget.assetId)
        : assets.find(asset => asset.url === (kind === "image" ? node.widget.imageUrl : node.widget.videoUrl));
      const authoredUrl = kind === "image" ? node.widget.imageUrl : node.widget.videoUrl;
      if (!asset) {
        if (kind === "video" && !node.widget.assetId
          && (!authoredUrl || !authoredUrl.startsWith(`/assets/projects/${publication.projectId}/`))) continue;
        throw new Error(`Published ${kind} has no project asset: ${node.id}`);
      }
      if (authoredUrl && authoredUrl !== asset.url) throw new Error(`Published ${kind} ID and URL disagree`);
      const value = mediaRequest(asset, publication.projectId, [node.id], kind);
      const existing = requests.get(value.id);
      requests.set(value.id, existing ? { ...existing, nodeIds: [...existing.nodeIds, node.id] } : value);
    }
    return [...requests.values()];
  }
  return {
    async derive(publication, entryPageId, signal) {
      signal?.throwIfAborted();
      const document = published({ ...publication, publicationId: publication.id, entryPageId });
      if (JSON.stringify(document.application) !== JSON.stringify(publication.document)) throw new Error("Dashboard publication snapshot changed");
      const data: DashboardResolvedDataRequest[] = [];
      const capturedAt = Date.now();
      for (const node of document.application.pages.flatMap(page => page.nodes)) {
        if (node.kind !== "data-widget") continue;
        const source = dashboardSavedDataSource(store, publication.projectId, node, publication.applicationRevision);
        if (source) data.push({ id: dataId(node.id), nodeId: node.id,
          sourceRevision: JSON.stringify({ metadataSha256: source.metadataSha256, capturedAt }) });
      }
      const resources = [...mediaRequests(publication, entryPageId), ...await options.fonts?.derive(publication, signal) ?? []];
      if (new Set(resources.map(resource => resource.id)).size !== resources.length) throw new Error("Font and image resource IDs collide");
      return { data, resources };
    },
    async resolveData(authority, request, signal) {
      signal?.throwIfAborted();
      const document = published(authority);
      const node = document.application.pages.flatMap(page => page.nodes).find(node => node.id === request.nodeId);
      if (!node || node.kind !== "data-widget" || request.id !== dataId(node.id)) throw new Error("Unbound Dashboard data request");
      return readDashboardSavedData(config, store, authority.projectId, node, request.sourceRevision, signal, authority.applicationRevision);
    },
    async resourceRevision(authority, request, signal) {
      signal?.throwIfAborted();
      published(authority);
      const publication = store.getPublishedApplication(authority.publicationId)!;
      if (request.kind === "font") {
        if (!options.fonts) throw new Error("Published font catalog is not configured");
        return options.fonts.resourceRevision(publication, request, signal);
      }
      const current = mediaRequests(publication, authority.entryPageId).find(item => item.id === request.id);
      if (!current || current.objectKey !== request.objectKey || current.kind !== request.kind || current.mime !== request.mime
        || [...current.pageIds ?? []].sort().join("\0") !== [...request.pageIds ?? []].sort().join("\0")
        || [...current.nodeIds].sort().join("\0") !== [...request.nodeIds].sort().join("\0"))
        throw new Error("Dashboard resource no longer belongs to this publication");
      return current.revision;
    },
  };
}

function mediaRequest(asset: ProjectAssetRecord, projectId: string, nodeIds: readonly string[], kind: "image" | "video"): DashboardFrozenResourceRequest {
  const prefix = `/assets/projects/${projectId}/assets/${asset.id}/`;
  if (asset.projectId !== projectId || asset.kind !== kind
    || (kind === "image" ? !asset.mimeType.startsWith("image/") : asset.mimeType !== "video/mp4")
    || !asset.url.startsWith(prefix)) throw new Error(`Dashboard ${kind} is outside the published project`);
  const key = asset.url.slice("/assets/".length);
  if (/[?%#\\\u0000-\u001f]/.test(key) || key.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`Dashboard ${kind} object key is not canonical`);
  const revision = Date.parse(asset.updatedAt);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Dashboard asset revision is invalid");
  return { id: asset.id, kind, objectKey: key, mime: asset.mimeType, nodeIds, revision };
}
