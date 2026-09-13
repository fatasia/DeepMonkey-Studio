import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";

export type ResourceBrowseKind = "library" | "2d" | "template" | "prefab";

/** 外链只使用服务器持有的原始资源地址，不复制预览用的 Blob 或登录凭据。 */
export function resourceFileLink(resource: ModelRecord | ProjectAssetRecord, serverOrigin: string): string {
  const source = "sourceUrl" in resource ? resource.sourceUrl : resource.url;
  const url = new URL(source, serverOrigin);
  if (!source.trim() || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("资源尚无可复制的文件地址");
  }
  return url.href;
}

export function resourceBrowseLink(kind: ResourceBrowseKind, id: string, serverOrigin: string): string {
  const url = new URL("/manager?tab=assets", serverOrigin);
  url.hash = new URLSearchParams({ resourceKind: kind, resource: id }).toString();
  return url.href;
}

export function readResourceBrowseTarget(hash: string): { kind: ResourceBrowseKind; id: string } | undefined {
  const query = new URLSearchParams(hash.replace(/^#/, ""));
  const kind = query.get("resourceKind"), id = query.get("resource");
  if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id)) return;
  if (kind !== "library" && kind !== "2d" && kind !== "template" && kind !== "prefab") return;
  return { kind, id };
}
