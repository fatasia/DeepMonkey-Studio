import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { assertPathSafeResourceId, type ApplicationScriptDependency } from "@bim-studio/contracts";
import { DirectHttpConnectorGateway } from "./connectorGateway.js";
import type { ObjectStore } from "./objects.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 90_000;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;

export interface ScriptDependencyServiceOptions {
  dataDir: string;
  objects: ObjectStore;
  npmCommand?: string;
}

export class ScriptDependencyService {
  private readonly gateway = new DirectHttpConnectorGateway({
    timeoutMs: 30_000,
    maxResponseBytes: MAX_SOURCE_BYTES,
    outboundPolicy: { allowPrivateNetwork: false, allowedPorts: [80, 443] },
  });

  constructor(private readonly options: ScriptDependencyServiceOptions) {}

  async installNpm(projectId: string, input: { packageName: string; version: string; specifier?: string }): Promise<ApplicationScriptDependency> {
    validateResourceId(projectId, "projectId");
    const packageName = validateSpecifier(input.packageName, "npm 包名");
    const specifier = validateSpecifier(input.specifier || packageName, "模块名");
    const version = input.version.trim();
    if (!exactVersionPattern.test(version)) throw new Error("npm 依赖必须填写固定版本，例如 1.2.3");

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "bim-studio-script-dependency-"));
    try {
      await writeFile(path.join(temporaryDirectory, "package.json"), JSON.stringify({ private: true }), "utf8");
      await runProcess(
        this.options.npmCommand ?? (process.platform === "win32" ? "npm.cmd" : "npm"),
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--save=false", "--prefer-offline", `${packageName}@${version}`],
        temporaryDirectory,
      );
      const packageRoot = path.join(temporaryDirectory, "node_modules", ...packageName.split("/"));
      const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version?: string; license?: string | { type?: string } };
      if (manifest.version !== version) throw new Error(`npm 实际解析为 ${manifest.version ?? "未知版本"}，未满足固定版本 ${version}`);
      const code = await bundlePackage(packageName, temporaryDirectory);
      const license = licenseText(manifest.license);
      return this.persist(projectId, {
        specifier,
        source: "npm",
        requested: `${packageName}@${version}`,
        resolvedVersion: version,
        fileName: `${safeFileName(specifier)}-${version}.mjs`,
        code,
        ...(license ? { license } : {}),
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async installUpload(projectId: string, specifierInput: string, fileName: string, source: Buffer): Promise<ApplicationScriptDependency> {
    validateResourceId(projectId, "projectId");
    const specifier = validateSpecifier(specifierInput, "模块名");
    assertSource(source, fileName);
    const code = await bundleSource(source.toString("utf8"), fileName);
    return this.persist(projectId, { specifier, source: "upload", requested: fileName, fileName: `${safeFileName(specifier)}.mjs`, code });
  }

  async installExternal(projectId: string, input: { url: string; specifier: string }): Promise<ApplicationScriptDependency> {
    validateResourceId(projectId, "projectId");
    const specifier = validateSpecifier(input.specifier, "模块名");
    const sourceUrl = input.url.trim();
    const response = await this.gateway.execute({
      version: 1,
      gateway: "server",
      transport: "http",
      endpoint: sourceUrl,
      access: "read-only",
      http: { method: "GET", refresh: { intervalMs: 60_000, immediate: true } },
    });
    if (typeof response.data !== "string") throw new Error("外部地址返回的不是 JavaScript 文本");
    const source = Buffer.from(response.data, "utf8");
    assertSource(source, sourceUrl);
    const sourceName = new URL(sourceUrl).pathname.split("/").at(-1) || "external.js";
    const code = await bundleSource(response.data, sourceName);
    return this.persist(projectId, { specifier, source: "external-url", requested: sourceUrl, fileName: `${safeFileName(specifier)}.mjs`, code });
  }

  async remove(projectId: string, dependencyId: string): Promise<void> {
    validateResourceId(projectId, "projectId");
    validateResourceId(dependencyId, "dependencyId");
    const prefix = dependencyPrefix(projectId, dependencyId);
    await this.options.objects.removePrefix(prefix);
    await rm(path.join(this.options.dataDir, ...prefix.split("/")), { recursive: true, force: true });
  }

  async content(projectId: string, dependencyId: string) {
    validateResourceId(projectId, "projectId");
    validateResourceId(dependencyId, "dependencyId");
    return this.options.objects.read(`${dependencyPrefix(projectId, dependencyId)}/index.mjs`);
  }

  private async persist(
    projectId: string,
    input: Omit<ApplicationScriptDependency, "id" | "assetUrl" | "integrity" | "size" | "installedAt"> & { code: string },
  ): Promise<ApplicationScriptDependency> {
    const bytes = Buffer.from(input.code, "utf8");
    if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error(`依赖打包后超过 ${MAX_BUNDLE_BYTES / 1024 / 1024} MB，请拆分或换用轻量包`);
    const id = randomUUID();
    const key = `${dependencyPrefix(projectId, id)}/index.mjs`;
    const localPath = path.join(this.options.dataDir, ...key.split("/"));
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, bytes);
    await this.options.objects.putFile(key, localPath);
    const integrity = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
    const { code: _code, ...metadata } = input;
    return {
      ...metadata,
      id,
      assetUrl: `/api/projects/${encodeURIComponent(projectId)}/script-dependencies/${id}/content`,
      integrity,
      size: bytes.byteLength,
      installedAt: new Date().toISOString(),
    };
  }
}

export async function bundleSource(source: string, sourceFile: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, sourcefile: sourceFile, loader: sourceFile.endsWith(".ts") ? "ts" : "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    sourcemap: "inline",
    legalComments: "eof",
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error("JavaScript 模块没有生成可运行输出");
  return output;
}

async function bundlePackage(packageName: string, workingDirectory: string): Promise<string> {
  const result = await build({
    entryPoints: [packageName],
    absWorkingDir: workingDirectory,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    sourcemap: "inline",
    legalComments: "eof",
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error("npm 包没有生成浏览器可用入口");
  return output;
}

function runProcess(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `npm 安装失败（退出码 ${String(code)}）`));
    });
  });
}

function validateSpecifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!packageNamePattern.test(normalized)) throw new Error(`${label}格式无效`);
  return normalized;
}

function validateResourceId(value: string, label: string): void {
  assertPathSafeResourceId(value, label);
}

function assertSource(source: Buffer, label: string): void {
  if (source.byteLength === 0) throw new Error(`${label} 为空文件`);
  if (source.byteLength > MAX_SOURCE_BYTES) throw new Error(`JavaScript 源文件不能超过 ${MAX_SOURCE_BYTES / 1024 / 1024} MB`);
  if (source.includes(0)) throw new Error(`${label} 不是文本 JavaScript 文件`);
}

function dependencyPrefix(projectId: string, dependencyId: string): string {
  return `projects/${projectId}/script-dependencies/${dependencyId}`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "module";
}

function licenseText(value: string | { type?: string } | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  if (value && typeof value === "object" && typeof value.type === "string" && value.type.trim()) return value.type.trim().slice(0, 120);
  return undefined;
}
