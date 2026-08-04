import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { AppConfig } from "./config.js";

export interface ObjectReadResult {
  stream: Readable;
  completed: Promise<void>;
}

export interface ObjectStore {
  init(): Promise<void>;
  putFile(key: string, filePath: string): Promise<void>;
  putFileIfMissing(key: string, filePath: string): Promise<void>;
  syncDirectory(prefix: string, directory: string): Promise<void>;
  stat(key: string): Promise<boolean>;
  read(key: string): Promise<ObjectReadResult>;
  removePrefix(prefix: string): Promise<void>;
}

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly dataDir: string) {}
  async init(): Promise<void> {}
  async putFile(): Promise<void> {}
  async putFileIfMissing(): Promise<void> {}
  async syncDirectory(): Promise<void> {}
  async stat(key: string): Promise<boolean> {
    try {
      await access(safeLocalPath(this.dataDir, key));
      return true;
    } catch {
      return false;
    }
  }
  async read(key: string): Promise<ObjectReadResult> {
    const stream = createReadStream(safeLocalPath(this.dataDir, key));
    return { stream, completed: Promise.resolve() };
  }
  async removePrefix(): Promise<void> {}
}

export class MinioObjectStore implements ObjectStore {
  private readonly targetRoot: string;
  private readonly processEnvironment: NodeJS.ProcessEnv;
  private readonly configDirectory: string;

  constructor(private readonly config: AppConfig["objects"]["minio"]) {
    this.targetRoot = `${config.alias}/${config.bucket}`;
    const endpoint = new URL(config.endpoint);
    endpoint.username = config.accessKey;
    endpoint.password = config.secretKey;
    this.configDirectory = path.resolve(process.env.MINIO_MC_CONFIG_DIR ?? path.join(process.cwd(), "data", "mc-config"));
    this.processEnvironment = {
      [`MC_HOST_${config.alias}`]: endpoint.toString(),
      MC_CONFIG_DIR: this.configDirectory
    };
  }

  async init(): Promise<void> {
    await mkdir(this.configDirectory, { recursive: true });
    await this.run(["mb", "--ignore-existing", this.targetRoot]);
  }

  async putFile(key: string, filePath: string): Promise<void> {
    await this.run(["cp", "--quiet", filePath, this.target(key)]);
  }

  async putFileIfMissing(key: string, filePath: string): Promise<void> {
    if (!await this.stat(key)) await this.putFile(key, filePath);
  }

  async syncDirectory(prefix: string, directory: string): Promise<void> {
    for (const filePath of await filesRecursively(directory)) {
      const relative = path.relative(directory, filePath).split(path.sep).join("/");
      await this.putFile(`${trimSlashes(prefix)}/${relative}`, filePath);
    }
  }

  async stat(key: string): Promise<boolean> {
    try {
      await this.run(["stat", "--quiet", this.target(key)]);
      return true;
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<ObjectReadResult> {
    const child = spawn(this.config.mcPath, ["cat", this.target(key)], {
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...this.processEnvironment }
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    const completed = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `MinIO 读取失败：${String(code)}`)));
    });
    return { stream: child.stdout, completed };
  }

  async removePrefix(prefix: string): Promise<void> {
    await this.run(["rm", "--recursive", "--force", this.target(prefix)]);
  }

  private target(key: string): string {
    return `${this.targetRoot}/${trimSlashes(key)}`;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.mcPath, args, {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...this.processEnvironment }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
      child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `MinIO 命令退出码 ${String(code)}`)));
    });
  }
}

export function createObjectStore(config: AppConfig): ObjectStore {
  return config.objects.provider === "minio"
    ? new MinioObjectStore(config.objects.minio)
    : new LocalObjectStore(config.dataDir);
}

export async function migrateLocalObjects(store: ObjectStore, dataDir: string): Promise<number> {
  const projectsDirectory = path.join(dataDir, "projects");
  let migrated = 0;
  try {
    for (const filePath of await filesRecursively(projectsDirectory)) {
      const key = `projects/${path.relative(projectsDirectory, filePath).split(path.sep).join("/")}`;
      if (!await store.stat(key)) {
        await store.putFile(key, filePath);
        migrated += 1;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return migrated;
}

function safeLocalPath(dataDir: string, key: string): string {
  const root = path.resolve(dataDir);
  const resolved = path.resolve(root, trimSlashes(key));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("对象路径越界");
  return resolved;
}

function trimSlashes(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error("对象键无效");
  return normalized;
}

async function filesRecursively(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesRecursively(entryPath));
    else if (entry.isFile()) output.push(entryPath);
  }
  return output;
}
