import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * GI 探针网格烘焙结果的服务端内容寻址存储（F3 发布一致性切片）。
 *
 * == 设计取舍 ==
 * 1. 不进 MetadataStore 文档：单层烘焙最大 64^3×96B ≈ 25MB JSON（级联更大），而
 *    JsonStore/SqliteStore 都是"整文档重写"持久化——塞进文档会让每次保存场景都
 *    重写几十 MB。这里走独立文件落盘（与 capturePublicationResource 的内容寻址
 *    资源同一模式），SQLite/JSON 双元数据后端都无感。
 * 2. 内容寻址：文件键 = (sceneId, sourceHash)。sourceHash 是浏览器端计算的
 *    "编译器严格源投影哈希"（与发布会话态同一投影），服务端只做透传存储，
 *    不重复实现投影逻辑（投影代码在 web 与编译器 bundle 里，此处引入第三份
 *    实现只会制造漂移）。同 hash 覆盖写 = 幂等（最终状态一致）。
 * 3. 压缩落盘：JSON → gzip buffer → 原子写（临时文件 + rename），文件名带
 *    .json.gz；读取时解压回 JSON 文档。
 * 4. 容量：单文档字节上限由调用方校验（路由默认 64MB）；目录按 mtime 保留最近
 *    MAX_BAKES_PER_SCENE 份（与发布会话态 MAX_SESSION_ENTRIES 同语义），场景
 *    反复编辑产生的旧烘焙不会无限堆积；项目删除时随 dataDir/projects 之外的单
 *    独目录保留（键含场景语义哈希，残留文件不会被错误注入——发布链按当前场景
 *    语义哈希精确匹配，对不上即不带）。
 * 5. 诚实边界：场景草稿删除不联动清理本目录（场景删除走 store，不感知文件），
 *    残留只占空间不影响正确性。
 */

/** 每场景保留的烘焙份数上限（与会话态 MAX_SESSION_ENTRIES 对齐）。 */
export const MAX_BAKES_PER_SCENE = 4;

/** 编译器严格源投影哈希（sha256 hex 小写）。 */
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** 一次持久化的探针烘焙文档（PUT 请求体 / GET 响应体同形）。 */
export interface ProbeGridBakeDocument {
  readonly sourceHash: string;
  /** 烘焙数据（SceneIrradianceProbeBake 形状；服务端不深校验，编译器 fail-closed 把关）。 */
  readonly bake: unknown;
  readonly probeCount?: number;
  readonly coveredCount?: number;
  readonly bakedAt?: string;
}

/** 候选编译链的透传条目：gzip 原始字节 + 键（由编译线程只解压命中那份）。 */
export interface ProbeGridBakeCandidate {
  readonly sourceHash: string;
  readonly gzip: Uint8Array;
}

export function assertProbeGridBakeSourceHash(sourceHash: unknown): string {
  if (typeof sourceHash !== "string" || !SOURCE_HASH_PATTERN.test(sourceHash)) {
    throw Object.assign(new Error("sourceHash 必须是 64 位十六进制 sha256"), { statusCode: 400 });
  }
  return sourceHash;
}

/** 校验并规范化 PUT 文档：bake 必须是 JSON 对象，序列化体积受 maxBytes 约束（413）。 */
export function normalizeProbeGridBakeDocument(body: unknown, maxBytes: number): ProbeGridBakeDocument {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("探针烘焙文档格式无效"), { statusCode: 400 });
  }
  const sourceHash = assertProbeGridBakeSourceHash((body as ProbeGridBakeDocument).sourceHash);
  const bake = (body as ProbeGridBakeDocument).bake;
  if (!bake || typeof bake !== "object" || Array.isArray(bake)) {
    throw Object.assign(new Error("探针烘焙数据必须是 JSON 对象"), { statusCode: 400 });
  }
  const source = body as ProbeGridBakeDocument;
  const document: ProbeGridBakeDocument = {
    sourceHash, bake,
    ...(source.probeCount !== undefined ? { probeCount: source.probeCount } : {}),
    ...(source.coveredCount !== undefined ? { coveredCount: source.coveredCount } : {}),
    ...(source.bakedAt !== undefined ? { bakedAt: source.bakedAt } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (bytes > maxBytes) throw Object.assign(new Error(`探针烘焙文档超过 ${maxBytes} 字节上限`), { statusCode: 413 });
  return document;
}

function bakeDirectory(dataDir: string, sceneId: string): string {
  if (!sceneId || /[\\/]/.test(sceneId) || sceneId.includes("..")) throw new Error("场景标识无效");
  return path.join(path.resolve(dataDir), "scenes", sceneId, "probe-bakes");
}

/** 场景 + 哈希联合键保存：gzip 原子覆盖写（同 hash 重复写入最终状态一致=幂等），随后按 mtime 淘汰超限旧份。 */
export async function storeProbeGridBakeDocument(input: {
  dataDir: string; sceneId: string; document: ProbeGridBakeDocument; maxBytes?: number;
}): Promise<{ bytes: number; compressedBytes: number }> {
  const directory = bakeDirectory(input.dataDir, input.sceneId);
  const sourceHash = assertProbeGridBakeSourceHash(input.document.sourceHash);
  const json = Buffer.from(JSON.stringify(input.document), "utf8");
  const limit = input.maxBytes ?? Number.POSITIVE_INFINITY;
  if (json.byteLength > limit) throw Object.assign(new Error(`探针烘焙文档超过 ${limit} 字节上限`), { statusCode: 413 });
  const gzip = gzipSync(json);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${sourceHash}.json.gz`);
  const temporary = path.join(directory, `.${sourceHash}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporary, gzip);
  try {
    await renameReplace(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await evictOldestBakes(directory);
  return { bytes: json.byteLength, compressedBytes: gzip.byteLength };
}

/** Windows 上 rename 覆盖已有文件在杀毒/索引器竞态下可能 EPERM，做一次有界重试。 */
async function renameReplace(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EACCES" || code === "ENOENT") && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/** 目录内保留最近 MAX_BAKES_PER_SCENE 份，其余删除（内容寻址，删除只影响可用性）。 */
async function evictOldestBakes(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files: Array<{ name: string; mtime: number }> = [];
  for (const name of entries) {
    if (!name.endsWith(".json.gz")) continue;
    const info = await stat(path.join(directory, name)).catch(() => undefined);
    if (info?.isFile()) files.push({ name, mtime: info.mtimeMs });
  }
  files.sort((a, b) => a.mtime - b.mtime);
  for (const stale of files.slice(0, Math.max(0, files.length - MAX_BAKES_PER_SCENE))) {
    await rm(path.join(directory, stale.name), { force: true }).catch(() => undefined);
  }
}

/** 按 (sceneId, sourceHash) 读取；不存在返回 undefined；存在但损坏按 fail-closed 抛错。 */
export async function loadProbeGridBakeDocument(input: {
  dataDir: string; sceneId: string; sourceHash: string;
}): Promise<ProbeGridBakeDocument | undefined> {
  const directory = bakeDirectory(input.dataDir, input.sceneId);
  const sourceHash = assertProbeGridBakeSourceHash(input.sourceHash);
  let gzip: Buffer;
  try {
    gzip = await readFile(path.join(directory, `${sourceHash}.json.gz`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const document = JSON.parse(gunzipSync(gzip).toString("utf8")) as ProbeGridBakeDocument;
  if (!document || typeof document !== "object" || document.sourceHash !== sourceHash) {
    throw new Error("探针烘焙文档身份校验失败");
  }
  return document;
}

/** 候选编译链透传：列出该场景全部烘焙的 gzip 原始字节（不解压，命中方才解压）。 */
export async function listProbeGridBakeCandidates(input: {
  dataDir: string; sceneId: string;
}): Promise<ProbeGridBakeCandidate[]> {
  const directory = bakeDirectory(input.dataDir, input.sceneId);
  const entries = await readdir(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const candidates: ProbeGridBakeCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json.gz")) continue;
    const sourceHash = name.slice(0, -".json.gz".length);
    if (!SOURCE_HASH_PATTERN.test(sourceHash)) continue;
    try {
      candidates.push({ sourceHash, gzip: await readFile(path.join(directory, name)) });
    } catch { /* 读取竞态：跳过该份，不阻塞候选编译 */ }
  }
  return candidates;
}

/** 候选内容身份（诊断/测试用）：gzip 字节的 sha256。 */
export function probeGridBakeCandidateDigest(candidate: ProbeGridBakeCandidate): string {
  return createHash("sha256").update(candidate.gzip).digest("hex");
}

/** 仅测试使用：场景烘焙目录（未创建时不存在）。 */
export function probeGridBakeDirectoryForTest(dataDir: string, sceneId: string): string {
  return bakeDirectory(dataDir, sceneId);
}
