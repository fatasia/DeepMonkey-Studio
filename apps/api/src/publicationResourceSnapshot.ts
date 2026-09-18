import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectReadResult, ObjectStore } from "./objects.js";
import { LocalObjectStore } from "./objects.js";

export interface PublicationResourceSnapshot { key: string; bytes: number; sha256: string }
export interface CapturePublicationResourceInput {
  objects: ObjectStore; dataDir: string; projectId: string; sourceKey: string;
  signal?: AbortSignal; maxBytes?: number; expected?: { bytes: number; sha256: string };
}

/** 同内容幂等捕获；ObjectStore 不提供跨进程条件写，上传后必须验证实际对象。 */
export async function capturePublicationResource(input: CapturePublicationResourceInput): Promise<PublicationResourceSnapshot> {
  return capture(input);
}

/** 服务端生成的运行包与源资产共用不可变存储；不暴露临时公开资源 URL。 */
export async function storePublicationResourceBytes(input: Omit<CapturePublicationResourceInput, "sourceKey">,
  bytes: Uint8Array): Promise<PublicationResourceSnapshot> {
  input.signal?.throwIfAborted();
  if (bytes.byteLength > (input.maxBytes ?? 256 * 1024 ** 2)) throw new Error("资源字节上限超限");
  const content = Buffer.from(bytes);
  return capture({ ...input, sourceKey: `projects/${input.projectId}/generated/runtime` },
    () => ({ stream: Readable.from([content]), completed: Promise.resolve() }));
}

async function capture(input: CapturePublicationResourceInput,
  generatedSource?: () => ObjectReadResult): Promise<PublicationResourceSnapshot> {
  const { objects, projectId, sourceKey, signal } = input;
  const root = path.resolve(input.dataDir), maxBytes = input.maxBytes ?? 256 * 1024 ** 2;
  const expected = input.expected ? { ...input.expected } : undefined;
  signal?.throwIfAborted();
  validateKey(projectId, sourceKey);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("资源字节上限无效");
  if (expected && (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256))) throw new Error("预期资源身份无效");
  const stagingRoot = await directory(root, [".publication-resource-staging"]);
  const staging = await mkdtemp(path.join(stagingRoot, "capture-"));
  const temporary = path.join(staging, "resource");
  try {
    if (!generatedSource && objects instanceof LocalObjectStore) await validateLocalSource(root, sourceKey);
    signal?.throwIfAborted();
    const source = generatedSource ? generatedSource() : await objects.read(sourceKey);
    const digest = await readDigest(source, maxBytes, signal, temporary);
    if (expected) match(digest, expected);
    signal?.throwIfAborted();
    const key = `projects/${projectId}/publication-resources/sha256/${digest.sha256}`;
    const parent = await directory(root, ["projects", projectId, "publication-resources", "sha256"]);
    const local = path.join(parent, digest.sha256);
    // 硬链接只在目标不存在时原子建立完整文件，不暴露半写入文件。
    try { await link(temporary, local); }
    catch (reason) { if ((reason as NodeJS.ErrnoException).code !== "EEXIST") throw reason; }
    const stat = await lstat(local);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("已有资源不是普通文件");
    match(await readDigest({ stream: createReadStream(local), completed: Promise.resolve() }, maxBytes, signal), digest);
    signal?.throwIfAborted();
    // Local 实现不写文件；远端实现没有取消/原子 CAS 接口，需等待写入结束再检查取消。
    await objects.putFileIfMissing(key, local);
    signal?.throwIfAborted();
    match(await readDigest(await objects.read(key), maxBytes, signal), digest);
    signal?.throwIfAborted();
    return { key, ...digest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function validateLocalSource(root: string, key: string): Promise<void> {
  let current = root;
  const segments = key.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("本地源资源不能经过符号链接，且必须是普通文件");
    }
  }
}

function match(actual: { bytes: number; sha256: string }, expected: { bytes: number; sha256: string }) {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("资源字节数或 SHA-256 不匹配");
}

async function readDigest(read: ObjectReadResult, maxBytes: number, signal?: AbortSignal, destination?: string) {
  const hash = createHash("sha256"); let bytes = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(new Error("资源字节上限超限"));
    hash.update(chunk); callback(null, chunk);
  } });
  const sink = destination ? createWriteStream(destination, { flags: "wx" }) : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const abort = () => { read.stream.destroy(); };
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { abort(); rejectAbort(signal?.reason ?? new Error("资源捕获已取消")); };
  signal?.addEventListener("abort", onAbort, { once: true });
  // 立即观察 completed，进程失败时关闭流，避免等待永远不会结束的输出。
  const completed = read.completed.catch(reason => { abort(); throw reason; });
  const pumping = pipeline(read.stream, meter, sink);
  try {
    if (signal?.aborted) onAbort();
    await Promise.race([Promise.all([pumping, completed]), cancelled]);
    signal?.throwIfAborted();
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    read.stream.destroy(); meter.destroy(); sink.destroy();
    // 文件句柄关闭后才允许清理 staging；completed 已有拒绝处理，无须等待坏适配器。
    await pumping.catch(() => undefined);
  }
}

function validateKey(projectId: string, sourceKey: string) {
  const validSegment = (segment: string) => segment.length > 0 && segment !== "." && segment !== ".."
    && !/[<>:"\\|?*%\u0000-\u001f\u007f]/.test(segment) && !/[. ]$/.test(segment)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment);
  if (typeof projectId !== "string" || projectId.includes("/") || !validSegment(projectId)
    || typeof sourceKey !== "string" || !sourceKey.startsWith(`projects/${projectId}/`)
    || !sourceKey.split("/").every(validSegment)) throw new Error("资源路径无效或属于其他项目");
}

async function directory(root: string, segments: string[]): Promise<string> {
  await mkdir(root, { recursive: true }); let current = root;
  for (const segment of segments) {
    current = path.join(current, segment); await mkdir(current).catch(reason => {
      if ((reason as NodeJS.ErrnoException).code !== "EEXIST") throw reason;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("资源目录不能使用符号链接或普通文件");
  }
  return current;
}
