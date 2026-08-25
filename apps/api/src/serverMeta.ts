import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerMetaResponse } from "@bim-studio/contracts";

const INSTANCE_FILE = "server-instance-id";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function loadOrCreateServerInstanceId(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, INSTANCE_FILE);
  const current = await readServerInstanceId(filePath);
  if (current) return current;

  const generated = randomUUID();
  try {
    const handle = await open(filePath, "wx");
    try {
      await handle.writeFile(`${generated}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await waitForServerInstanceId(filePath);
    if (!existing) throw new Error("server-instance-id 文件为空");
    return existing;
  }
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

async function readServerInstanceId(filePath: string): Promise<string | undefined> {
  try {
    const current = (await readFile(filePath, "utf8")).trim();
    if (!current) return undefined;
    if (!UUID_V4.test(current)) throw new Error("server-instance-id 文件无效");
    return current.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForServerInstanceId(filePath: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await readServerInstanceId(filePath);
    if (current) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}
