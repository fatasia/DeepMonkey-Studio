import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPathSafeResourceId, type ScriptModule } from "@bim-studio/contracts";
import { ScriptGitError, type ScriptGitManifest, type ScriptGitManifestEntry } from "./scriptGitTypes.js";

const MAX_SCRIPT_COUNT = 256;
export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_SCRIPT_BYTES = 16 * 1024 * 1024;
const SCRIPT_FILE_PATTERN = /^script-[a-f0-9]{16}\.js$/;
const PERMISSIONS = new Set(["scene.read", "scene.write", "data.read", "data.write", "ai.invoke", "network.connect", "renderer.extend", "editor.extend"]);
const LIFECYCLES = new Set(["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"]);

export class ScriptGitWorkspace {
  readonly root: string;
  readonly scriptsDirectory: string;

  constructor(dataDir: string, projectId: string) {
    assertPathSafeResourceId(projectId, "projectId");
    const projectsRoot = path.resolve(dataDir, "projects");
    this.root = path.resolve(projectsRoot, projectId, "script-git");
    this.scriptsDirectory = path.join(this.root, "scripts");
    if (path.relative(projectsRoot, this.root).startsWith("..")) {
      throw validationError("脚本 Git 工作区路径无效");
    }
  }

  async ensureDirectories(): Promise<void> {
    // 先验证工作区本身，再创建子目录，避免已有符号链接把写入导向数据目录之外。
    await mkdir(this.root, { recursive: true });
    await this.rejectSymbolicLink(this.root);
    await mkdir(this.scriptsDirectory, { recursive: true });
    await this.rejectSymbolicLink(this.scriptsDirectory);
  }

  async sync(scripts: readonly ScriptModule[]): Promise<void> {
    validateScripts(scripts);
    await this.ensureDirectories();
    await this.assertAllowedWorkingTree();
    const manifest = createManifest(scripts);
    const expectedFiles = new Set(manifest.scripts.map((script) => script.file));
    const currentFiles = await readdir(this.scriptsDirectory, { withFileTypes: true });

    // 仅清理本模块自己生成的稳定脚本文件，未知文件会在提交前被安全门禁拒绝。
    await Promise.all(currentFiles
      .filter((entry) => entry.isFile() && SCRIPT_FILE_PATTERN.test(entry.name) && !expectedFiles.has(entry.name))
      .map((entry) => rm(path.join(this.scriptsDirectory, entry.name))));
    await Promise.all(manifest.scripts.map((entry, index) =>
      writeTextAtomically(path.join(this.scriptsDirectory, entry.file), scripts[index]!.code)));
    await writeJsonAtomically(path.join(this.scriptsDirectory, "manifest.json"), manifest);
    await this.assertAllowedWorkingTree();
  }

  async read(): Promise<ScriptModule[]> {
    const manifest = await this.readManifestFromDisk();
    return Promise.all(manifest.scripts.map(async ({ file, ...metadata }) => ({
      ...metadata,
      code: await readFile(path.join(this.scriptsDirectory, file), "utf8"),
    })));
  }

  async readManifestFromDisk(): Promise<ScriptGitManifest> {
    try {
      return validateManifest(JSON.parse(await readFile(path.join(this.scriptsDirectory, "manifest.json"), "utf8")));
    } catch (error) {
      if (error instanceof ScriptGitError) throw error;
      throw validationError(`脚本清单无法读取：${error instanceof Error ? error.message : "格式错误"}`);
    }
  }

  async assertAllowedWorkingTree(): Promise<void> {
    const rootEntries = await readdir(this.root, { withFileTypes: true });
    for (const entry of rootEntries) {
      if ((entry.name === ".git" || entry.name === "scripts") && entry.isDirectory()) continue;
      throw validationError(`脚本 Git 工作区包含不允许的路径：${entry.name}`);
    }
    const scriptEntries = await readdir(this.scriptsDirectory, { withFileTypes: true });
    for (const entry of scriptEntries) {
      if (entry.isFile() && (entry.name === "manifest.json" || SCRIPT_FILE_PATTERN.test(entry.name))) continue;
      throw validationError(`脚本 Git 工作区包含不允许的路径：scripts/${entry.name}`);
    }
  }

  private async rejectSymbolicLink(target: string): Promise<void> {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw validationError("脚本 Git 工作区不能使用符号链接");
  }
}

export function validateManifest(value: unknown): ScriptGitManifest {
  if (!value || typeof value !== "object") throw validationError("脚本清单不是对象");
  const manifest = value as Partial<ScriptGitManifest>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.scripts)) throw validationError("脚本清单版本无效");
  const scripts = manifest.scripts.map((entry) => {
    if (!entry || typeof entry !== "object") throw validationError("脚本清单条目无效");
    const candidate = entry as ScriptGitManifestEntry;
    if (!SCRIPT_FILE_PATTERN.test(candidate.file)) throw validationError("脚本清单包含不安全文件名");
    if (candidate.file !== stableFileName(candidate.id)) throw validationError(`脚本 ${candidate.id} 的文件名与稳定映射不一致`);
    return candidate;
  });
  validateScripts(scripts.map((script) => ({ ...script, code: "" })));
  if (new Set(scripts.map((script) => script.id)).size !== scripts.length) throw validationError("脚本 ID 不能重复");
  if (new Set(scripts.map((script) => script.file)).size !== scripts.length) throw validationError("脚本文件名不能重复");
  return { schemaVersion: 1, scripts };
}

export function isAllowedRemotePath(value: string): boolean {
  return value === "scripts/manifest.json" || /^scripts\/script-[a-f0-9]{16}\.js$/.test(value);
}

function createManifest(scripts: readonly ScriptModule[]): ScriptGitManifest {
  return {
    schemaVersion: 1,
    scripts: scripts.map(({ code: _code, ...script }) => ({ ...script, file: stableFileName(script.id) })),
  };
}

function stableFileName(id: string): string {
  return `script-${createHash("sha256").update(id).digest("hex").slice(0, 16)}.js`;
}

function validateScripts(scripts: readonly ScriptModule[]): void {
  if (scripts.length > MAX_SCRIPT_COUNT) throw validationError(`脚本数量不能超过 ${MAX_SCRIPT_COUNT}`);
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const script of scripts) {
    try {
      assertPathSafeResourceId(script.id, "script.id");
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "script.id 无效");
    }
    if (ids.has(script.id)) throw validationError(`脚本 ID 重复：${script.id}`);
    ids.add(script.id);
    assertText(script.name, "脚本名称", 200);
    if (typeof script.enabled !== "boolean" || script.apiVersion !== "1.0" || script.entrypoint !== "behavior") throw validationError(`脚本 ${script.id} 的基础字段无效`);
    if (!new Set(["worker-sandbox", "legacy-trusted-main-thread"]).has(script.runtime)) throw validationError(`脚本 ${script.id} 的运行时无效`);
    if (typeof script.code !== "string") throw validationError(`脚本 ${script.id} 的代码无效`);
    const bytes = Buffer.byteLength(script.code);
    if (bytes > MAX_SCRIPT_BYTES) throw validationError(`脚本 ${script.name} 不能超过 2 MB`);
    totalBytes += bytes;
    validateStringSet(script.lifecycle, LIFECYCLES, `脚本 ${script.name} 的生命周期`);
    validateStringSet(script.permissions, PERMISSIONS, `脚本 ${script.name} 的权限`);
    if (!Array.isArray(script.capabilities) || script.capabilities.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)) throw validationError(`脚本 ${script.name} 的能力声明无效`);
    if (script.target && (script.target.kind === "object" || script.target.kind === "component")) assertText(script.target.id, "脚本挂载目标", 200);
    else if (script.target && script.target.kind !== "scene") throw validationError(`脚本 ${script.name} 的挂载目标无效`);
  }
  if (totalBytes > MAX_TOTAL_SCRIPT_BYTES) throw validationError("项目脚本总大小不能超过 16 MB");
}

function validateStringSet(values: readonly string[], allowed: ReadonlySet<string>, label: string): void {
  if (!Array.isArray(values) || values.some((item) => !allowed.has(item))) throw validationError(`${label}无效`);
}

function assertText(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw validationError(`${label}必须为 1-${maxLength} 个字符`);
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  await writeTextAtomically(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(target: string, value: string): Promise<void> {
  const temporary = `${target}.writing`;
  try {
    await writeFile(temporary, value, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validationError(message: string): ScriptGitError {
  return new ScriptGitError("GIT_VALIDATION_FAILED", message, 400);
}
