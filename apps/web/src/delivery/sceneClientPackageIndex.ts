export interface SceneClientArchiveFile {
  path: string;
  content: string | ArrayBuffer;
  sourceUrl?: string;
}

/** 预检与最终索引共用路径规则，避免发布后才发现归档路径冲突。 */
export function validateSceneClientArchivePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    assertArchivePath(path);
    const identity = path.toLowerCase();
    if (seen.has(identity)) throw new Error(`客户端包路径重复或大小写冲突：${path}`);
    seen.add(identity);
  }
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (seen.has(path.slice(0, slash).toLowerCase())) throw new Error(`客户端包文件与目录路径冲突：${path}`);
    }
  }
}

/** 对已冻结归档内容建立索引；manifest.json 由交付器最后写入，不参与自身摘要。 */
export async function indexSceneClientArchiveFiles(files: readonly SceneClientArchiveFile[], signal?: AbortSignal): Promise<Array<{
  path: string; bytes: number; sha256: string; sourceUrl: string;
}>> {
  signal?.throwIfAborted();
  const paths = files.map(file => file.path);
  validateSceneClientArchivePaths(paths);
  // 首个 await 前复制全部字节，后续摘要不会读到调用方更改后的缓冲区。
  const snapshots = files.map((file, index) => {
    if (typeof file.content !== "string" && !(file.content instanceof ArrayBuffer)) throw new Error(`客户端包内容类型无效：${file.path}`);
    return { path: paths[index]!, sourceUrl: file.sourceUrl ?? "generated",
      content: typeof file.content === "string" ? new TextEncoder().encode(file.content) : new Uint8Array(file.content.slice(0)) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const indexed: Array<{ path: string; bytes: number; sha256: string; sourceUrl: string }> = [];
  for (const file of snapshots) {
    signal?.throwIfAborted();
    const digest = await crypto.subtle.digest("SHA-256", file.content);
    signal?.throwIfAborted();
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    indexed.push({ path: file.path, bytes: file.content.byteLength, sha256, sourceUrl: file.sourceUrl });
  }
  signal?.throwIfAborted();
  return indexed;
}

function assertArchivePath(path: string): void {
  if (typeof path !== "string" || /[\\:<>"|?*\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`客户端包路径无效：${String(path)}`);
  }
  if (path.split("/")[0]!.toLowerCase() === "manifest.json") throw new Error("manifest.json 是客户端包保留路径，不能自索引。");
}
