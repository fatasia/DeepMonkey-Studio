import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerMetaResponse } from "@bim-studio/contracts";

const INSTANCE_FILE = "server-instance-id";
const INSTANCE_ANCHOR_FILE = ".server-instance-id.value";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function loadOrCreateServerInstanceId(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, INSTANCE_FILE);
  const current = await readServerInstanceId(filePath);
  if (current.kind === "valid") return current.value;

  const anchorPath = path.join(dataDir, INSTANCE_ANCHOR_FILE);
  const anchor = await loadOrPublishAnchor(anchorPath, dataDir);
  await publishFinalIdentity(anchorPath, filePath, anchor);
  return anchor;
}

export function createServerMeta(serverInstanceId: string, now = () => new Date()): ServerMetaResponse {
  return {
    serverInstanceId,
    apiVersion: "1.0",
    serverTime: now().toISOString(),
    capabilities: {
      applications: { schemaVersions: [2], immutablePublications: true },
      legacyScenes: { schemaVersions: [1], routes: true },
      authentication: { providers: ["local"] },
      hosts: { browser: true, tauri: false }
    }
  };
}

export async function registerServerMetaRoute(app: FastifyInstance, serverInstanceId: string, now = () => new Date()): Promise<void> {
  app.get("/api/meta", async () => createServerMeta(serverInstanceId, now));
}

type IdentityFileState =
  | { kind: "missing" | "empty" }
  | { kind: "valid"; value: string };

async function readServerInstanceId(filePath: string): Promise<IdentityFileState> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const current = (await readFile(filePath, "utf8")).trim();
      if (!current) return { kind: "empty" };
      if (!UUID_V4.test(current)) throw new Error("server-instance-id 文件无效");
      return { kind: "valid", value: current.toLowerCase() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { kind: "missing" };
      // Windows 在并发替换硬链接时可能短暂返回 EPERM/EBUSY，短暂退避后重读。
      if ((code === "EPERM" || code === "EBUSY") && attempt < 19) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      throw error;
    }
  }
  throw new Error("server-instance-id 文件读取失败");
}

async function loadOrPublishAnchor(anchorPath: string, dataDir: string): Promise<string> {
  const existing = await readServerInstanceId(anchorPath);
  if (existing.kind === "valid") return existing.value;
  if (existing.kind === "empty") throw new Error("server-instance-id 锚点文件无效");

  const generated = randomUUID();
  const temporaryPath = path.join(dataDir, `.${INSTANCE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${generated}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporaryPath, anchorPath);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readServerInstanceId(anchorPath);
    if (winner.kind !== "valid") throw new Error("server-instance-id 锚点文件无效");
    return winner.value;
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function publishFinalIdentity(anchorPath: string, filePath: string, anchor: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await readServerInstanceId(filePath);
    if (current.kind === "valid") {
      if (current.value !== anchor) throw new Error("server-instance-id 文件与恢复锚点冲突");
      return;
    }
    if (current.kind === "empty") {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EPERM" && code !== "EBUSY") throw error;
        if (code === "EPERM" || code === "EBUSY") {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
      }
    }
    try {
      await link(anchorPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
      if (code === "EPERM" || code === "EBUSY") await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error("server-instance-id 文件发布失败");
}
