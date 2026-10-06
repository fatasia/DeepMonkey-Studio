/**
 * 资产热重载的 URL 击穿纯逻辑。
 *
 * 运行中场景重取同 URL 资产时,浏览器 HTTP 缓存与查看器内共享池/纹理源缓存都以
 * 完整 URL 为键;查询参数对 API 端 `/assets/*` 静态路由透明(fastify 通配参数不含
 * query),因此追加一次性的 `t=<token>` 查询即可同时击穿全部三层缓存。
 * 持久化语义不受影响:bust 只发生在运行时取数 URL,场景快照仍保存干净 URL。
 */

/** 给资产 URL 追加(或合并)cache-bust 查询参数;已带查询时用 & 连接。 */
export function cacheBustedUrl(url: string, token: string | number): string {
  if (!url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}t=${encodeURIComponent(String(token))}`;
}

/** 会被运行时直接取数的 manifest 字段;击穿只作用于取数 URL,不动身份与引用。 */
const MANIFEST_URL_FIELDS = ["geometryUrl", "hierarchyUrl", "propertiesUrl", "inspectionUrl", "pmiUrl"] as const;

/** 对 manifest 中全部取数 URL 做击穿;deepAssetPackage/robot 等身份引用原样保留。 */
export function manifestWithCacheBust<T extends { geometryUrl?: string; hierarchyUrl?: string; propertiesUrl?: string; inspectionUrl?: string; pmiUrl?: string; lods?: Array<{ url: string }> }>(
  manifest: T,
  token: string | number,
): T {
  const lods = manifest.lods?.map(lod => ({ ...lod, url: cacheBustedUrl(lod.url, token) }));
  return {
    ...manifest,
    ...Object.fromEntries(
      MANIFEST_URL_FIELDS.filter(field => typeof manifest[field] === "string")
        .map(field => [field, cacheBustedUrl(manifest[field] as string, token)]),
    ),
    ...(lods ? { lods } : {}),
  };
}

/** 收集 manifest 里全部取数 URL(几何、LOD、元数据),用于"变更 URL → 模型"反查。 */
export function manifestAssetUrls(manifest: { geometryUrl?: string; hierarchyUrl?: string; propertiesUrl?: string; inspectionUrl?: string; pmiUrl?: string; lods?: Array<{ url: string }> } | undefined | null): string[] {
  if (!manifest) return [];
  const urls = MANIFEST_URL_FIELDS.map(field => manifest[field]).filter((url): url is string => typeof url === "string" && url.length > 0);
  for (const lod of manifest.lods ?? []) if (typeof lod.url === "string" && lod.url) urls.push(lod.url);
  return urls;
}
