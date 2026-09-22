/** 仅登记可重新渲染的缩略图字符串，不接触项目数据和浏览器持久存储。 */
const caches = new Map<string, Map<string, string>>();
let generation = 0;

export function createThumbnailCache(name: string): Map<string, string> {
  const cache = new Map<string, string>();
  caches.set(name, cache);
  return cache;
}

export function thumbnailCacheGeneration(): number { return generation; }

export function inspectThumbnailCaches(): { entries: number; estimatedBytes: number } {
  let entries = 0;
  let estimatedBytes = 0;
  for (const cache of caches.values()) {
    entries += cache.size;
    for (const [key, value] of cache) estimatedBytes += (key.length + value.length) * 2;
  }
  return { entries, estimatedBytes };
}

export function clearThumbnailCaches(): ReturnType<typeof inspectThumbnailCaches> {
  const removed = inspectThumbnailCaches();
  generation += 1;
  for (const cache of caches.values()) cache.clear();
  return removed;
}
