import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ScriptModule } from "@bim-studio/contracts";
import { NativeGitCommandRunner, sanitizeGitOutput, type GitCommandResult, type GitCommandRunner } from "./scriptGitProcess.js";
import {
  ScriptGitError,
  type ScriptGitCommit,
  type ScriptGitCommitResult,
  type ScriptGitPullResult,
  type ScriptGitPushResult,
  type ScriptGitRemoteState,
  type ScriptGitServiceContract,
  type ScriptGitStatus,
} from "./scriptGitTypes.js";
import {
  isAllowedRemotePath,
  MAX_SCRIPT_BYTES,
  MAX_TOTAL_SCRIPT_BYTES,
  ScriptGitWorkspace,
  validateManifest,
} from "./scriptGitWorkspace.js";

interface ScriptGitServiceOptions {
  dataDir: string;
  runner?: GitCommandRunner;
  commandTimeoutMs?: number;
  remoteTimeoutMs?: number;
}

interface RemoteTreeEntry {
  mode: string;
  type: string;
  path: string;
}

const DEFAULT_BRANCH = "main";
const COMMIT_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s";

export class ScriptGitService implements ScriptGitServiceContract {
  private readonly runner: GitCommandRunner;
  private readonly commandTimeoutMs: number;
  private readonly remoteTimeoutMs: number;
  private readonly projectQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ScriptGitServiceOptions) {
    this.runner = options.runner ?? new NativeGitCommandRunner();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.remoteTimeoutMs = options.remoteTimeoutMs ?? 60_000;
  }

  status(projectId: string): Promise<ScriptGitStatus> {
    return this.exclusive(projectId, async (workspace) => {
      if (!await this.isInitialized(workspace)) return emptyStatus();
      await workspace.assertAllowedWorkingTree();
      return this.readStatus(workspace);
    });
  }

  history(projectId: string, limit = 20): Promise<ScriptGitCommit[]> {
    return this.exclusive(projectId, async (workspace) => {
      const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
      if (!await this.isInitialized(workspace) || !await this.hasHead(workspace)) return [];
      await workspace.assertAllowedWorkingTree();
      await this.assertAllowedGitIndex(workspace);
      const result = await this.git(workspace, ["log", `-n${safeLimit}`, `--format=${COMMIT_FORMAT}`, "--", "scripts"]);
      return result.stdout.split(/\r?\n/).filter(Boolean).map(parseCommit);
    });
  }

  syncAndCommit(projectId: string, scripts: readonly ScriptModule[], message: string): Promise<ScriptGitCommitResult> {
    return this.exclusive(projectId, async (workspace) => {
      validateCommitMessage(message);
      await this.ensureRepository(workspace);
      await workspace.sync(scripts);
      await this.git(workspace, ["add", "-A", "--", "scripts"]);
      const staged = await this.git(workspace, ["diff", "--cached", "--name-only", "--", "scripts"]);
      if (!staged.stdout.trim()) return { committed: false, status: await this.readStatus(workspace) };
      await this.git(workspace, ["commit", "-m", message.trim(), "--", "scripts"], "提交脚本失败");
      const [commit] = await this.latestCommits(workspace, 1);
      return { committed: true, ...(commit ? { commit } : {}), status: await this.readStatus(workspace) };
    });
  }

  configureRemote(projectId: string, url: string, branch: string): Promise<ScriptGitStatus> {
    return this.exclusive(projectId, async (workspace) => {
      const safeUrl = validateRemoteUrl(url);
      const safeBranch = validateBranch(branch);
      await this.ensureRepository(workspace);
      const existing = await this.gitOptional(workspace, ["remote", "get-url", "origin"]);
      await this.git(workspace, existing.exitCode === 0
        ? ["remote", "set-url", "origin", safeUrl]
        : ["remote", "add", "origin", safeUrl], "配置脚本远端失败");
      await this.git(workspace, ["config", "bim-studio.remoteBranch", safeBranch]);
      return this.readStatus(workspace);
    });
  }

  removeRemote(projectId: string): Promise<ScriptGitStatus> {
    return this.exclusive(projectId, async (workspace) => {
      if (!await this.isInitialized(workspace)) return emptyStatus();
      await workspace.assertAllowedWorkingTree();
      const existing = await this.gitOptional(workspace, ["remote", "get-url", "origin"]);
      if (existing.exitCode === 0) await this.git(workspace, ["remote", "remove", "origin"]);
      await this.gitOptional(workspace, ["config", "--unset", "bim-studio.remoteBranch"]);
      return this.readStatus(workspace);
    });
  }

  pull(projectId: string): Promise<ScriptGitPullResult> {
    return this.exclusive(projectId, async (workspace) => {
      await this.ensureRepository(workspace);
      if (!await this.hasHead(workspace)) throw new ScriptGitError("GIT_OPERATION_FAILED", "请先提交一次本地脚本快照，再拉取远端", 409);
      const before = await this.readStatus(workspace);
      if (!before.clean) throw new ScriptGitError("GIT_DIRTY", "存在未提交脚本修改，请先提交后再拉取", 409);
      const remote = requireRemote(before.remote);
      const previousHead = (await this.git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
      await this.gitRemote(workspace, ["fetch", "--no-tags", "origin", remote.branch], "拉取远端脚本失败");
      await this.validateFetchedSnapshot(workspace);
      const merge = await this.gitOptional(workspace, ["merge", "--ff-only", "FETCH_HEAD"]);
      if (merge.exitCode !== 0) {
        throw new ScriptGitError("GIT_DIVERGED", "远端与本地脚本历史已分叉，请人工处理差异；系统没有重置或覆盖本地文件", 409);
      }
      await this.configureUpstream(workspace, remote.branch);
      const currentHead = (await this.git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
      return { updated: previousHead !== currentHead, scripts: await workspace.read(), status: await this.readStatus(workspace) };
    });
  }

  push(projectId: string): Promise<ScriptGitPushResult> {
    return this.exclusive(projectId, async (workspace) => {
      await this.ensureRepository(workspace);
      if (!await this.hasHead(workspace)) throw new ScriptGitError("GIT_OPERATION_FAILED", "尚无可推送的脚本提交", 409);
      const status = await this.readStatus(workspace);
      if (!status.clean) throw new ScriptGitError("GIT_DIRTY", "存在未提交脚本修改，请先提交后再推送", 409);
      const remote = requireRemote(status.remote);
      const result = await this.gitOptional(workspace, ["push", "origin", `HEAD:refs/heads/${remote.branch}`], this.remoteTimeoutMs);
      if (result.exitCode !== 0) {
        const detail = sanitizeGitOutput(result.stderr);
        throw new ScriptGitError("GIT_REMOTE_REJECTED", `远端拒绝推送，未使用强制覆盖${detail ? `：${detail}` : ""}`, 409);
      }
      await this.configureUpstream(workspace, remote.branch);
      return { pushed: true, status: await this.readStatus(workspace) };
    });
  }

  private async validateFetchedSnapshot(workspace: ScriptGitWorkspace): Promise<void> {
    const tree = parseRemoteTree((await this.git(workspace, ["ls-tree", "-r", "-z", "FETCH_HEAD"])).stdout);
    if (!tree.length || tree.some((entry) => entry.type !== "blob" || entry.mode !== "100644" || !isAllowedRemotePath(entry.path))) {
      throw new ScriptGitError("GIT_REMOTE_REJECTED", "远端仓库包含脚本目录以外的文件、不安全链接或可执行文件，已拒绝拉取", 409);
    }
    const manifestEntry = tree.find((entry) => entry.path === "scripts/manifest.json");
    if (!manifestEntry) throw new ScriptGitError("GIT_REMOTE_REJECTED", "远端缺少 scripts/manifest.json", 409);
    let manifest;
    try {
      const source = (await this.git(workspace, ["show", "FETCH_HEAD:scripts/manifest.json"])).stdout;
      manifest = validateManifest(JSON.parse(source));
    } catch (error) {
      if (error instanceof ScriptGitError && error.code === "GIT_VALIDATION_FAILED") {
        throw new ScriptGitError("GIT_REMOTE_REJECTED", `远端脚本清单无效：${error.message}`, 409);
      }
      throw error;
    }
    const expected = new Set(["scripts/manifest.json", ...manifest.scripts.map((script) => `scripts/${script.file}`)]);
    if (tree.length !== expected.size || tree.some((entry) => !expected.has(entry.path))) {
      throw new ScriptGitError("GIT_REMOTE_REJECTED", "远端脚本文件与清单不一致，已拒绝拉取", 409);
    }
    let totalBytes = 0;
    for (const script of manifest.scripts) {
      const sizeText = (await this.git(workspace, ["cat-file", "-s", `FETCH_HEAD:scripts/${script.file}`])).stdout.trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SCRIPT_BYTES) {
        throw new ScriptGitError("GIT_REMOTE_REJECTED", `远端脚本 ${script.name} 超过 2 MB 或大小无效`, 409);
      }
      totalBytes += size;
    }
    if (totalBytes > MAX_TOTAL_SCRIPT_BYTES) throw new ScriptGitError("GIT_REMOTE_REJECTED", "远端项目脚本总大小超过 16 MB", 409);
  }

  private async readStatus(workspace: ScriptGitWorkspace): Promise<ScriptGitStatus> {
    await this.assertAllowedGitIndex(workspace);
    const result = await this.git(workspace, ["status", "--porcelain=v1", "--branch", "--untracked-files=all", "--", "scripts"]);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const branch = parseBranch(lines.shift() ?? "") || DEFAULT_BRANCH;
    const changes = lines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replaceAll("\\", "/") }));
    const remote = await this.readRemote(workspace, branch);
    const counts = remote.configured ? await this.aheadBehind(workspace, remote.branch) : { ahead: 0, behind: 0 };
    return { initialized: true, branch, clean: changes.length === 0, changes, ...counts, remote };
  }

  private async readRemote(workspace: ScriptGitWorkspace, currentBranch: string): Promise<ScriptGitRemoteState> {
    const url = await this.gitOptional(workspace, ["remote", "get-url", "origin"]);
    if (url.exitCode !== 0 || !url.stdout.trim()) return { configured: false, message: "未配置脚本远端，可只使用本地版本记录" };
    const configuredBranch = await this.gitOptional(workspace, ["config", "--get", "bim-studio.remoteBranch"]);
    return { configured: true, url: sanitizeGitOutput(url.stdout), branch: configuredBranch.stdout.trim() || currentBranch };
  }

  private async aheadBehind(workspace: ScriptGitWorkspace, remoteBranch: string): Promise<{ ahead: number; behind: number }> {
    const result = await this.gitOptional(workspace, ["rev-list", "--left-right", "--count", `refs/remotes/origin/${remoteBranch}...HEAD`]);
    if (result.exitCode !== 0) return { ahead: 0, behind: 0 };
    const [behind = "0", ahead = "0"] = result.stdout.trim().split(/\s+/);
    return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
  }

  private async ensureRepository(workspace: ScriptGitWorkspace): Promise<void> {
    await workspace.ensureDirectories();
    if (!await this.isInitialized(workspace)) await this.git(workspace, ["init", `--initial-branch=${DEFAULT_BRANCH}`], "初始化脚本仓库失败");
    await this.assertGitDirectory(workspace);
    if ((await this.gitOptional(workspace, ["config", "--get", "user.name"])).exitCode !== 0) {
      await this.git(workspace, ["config", "user.name", "Deep Monkey Studio Script Editor"]);
    }
    if ((await this.gitOptional(workspace, ["config", "--get", "user.email"])).exitCode !== 0) {
      await this.git(workspace, ["config", "user.email", "script-editor@local"]);
    }
    await workspace.assertAllowedWorkingTree();
    await this.assertAllowedGitIndex(workspace);
  }

  private async assertAllowedGitIndex(workspace: ScriptGitWorkspace): Promise<void> {
    const tracked = (await this.git(workspace, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
    const invalid = tracked.find((entry) => !isAllowedRemotePath(entry.replaceAll("\\", "/")));
    if (invalid) {
      throw new ScriptGitError("GIT_VALIDATION_FAILED", `脚本仓库索引包含不允许的路径：${invalid}`, 400);
    }
  }

  private async assertGitDirectory(workspace: ScriptGitWorkspace): Promise<void> {
    const stat = await lstat(path.join(workspace.root, ".git"));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ScriptGitError("GIT_VALIDATION_FAILED", "脚本仓库 .git 必须是本地目录", 400);
  }

  private async isInitialized(workspace: ScriptGitWorkspace): Promise<boolean> {
    try {
      const stat = await lstat(path.join(workspace.root, ".git"));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ScriptGitError("GIT_VALIDATION_FAILED", "脚本仓库 .git 路径无效", 400);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async hasHead(workspace: ScriptGitWorkspace): Promise<boolean> {
    return (await this.gitOptional(workspace, ["rev-parse", "--verify", "HEAD"])).exitCode === 0;
  }

  private latestCommits(workspace: ScriptGitWorkspace, limit: number): Promise<ScriptGitCommit[]> {
    return this.git(workspace, ["log", `-n${limit}`, `--format=${COMMIT_FORMAT}`, "--", "scripts"])
      .then((result) => result.stdout.split(/\r?\n/).filter(Boolean).map(parseCommit));
  }

  private async configureUpstream(workspace: ScriptGitWorkspace, remoteBranch: string): Promise<void> {
    const localBranch = (await this.git(workspace, ["branch", "--show-current"])).stdout.trim() || DEFAULT_BRANCH;
    await this.git(workspace, ["config", `branch.${localBranch}.remote`, "origin"]);
    await this.git(workspace, ["config", `branch.${localBranch}.merge`, `refs/heads/${remoteBranch}`]);
  }

  private async git(workspace: ScriptGitWorkspace, args: readonly string[], context = "Git 操作失败"): Promise<GitCommandResult> {
    const result = await this.runner.run(workspace.root, args, this.commandTimeoutMs);
    if (result.exitCode === 0) return result;
    const detail = sanitizeGitOutput(result.stderr);
    throw new ScriptGitError("GIT_OPERATION_FAILED", `${context}${detail ? `：${detail}` : ""}`, 502);
  }

  private gitOptional(workspace: ScriptGitWorkspace, args: readonly string[], timeoutMs = this.commandTimeoutMs): Promise<GitCommandResult> {
    return this.runner.run(workspace.root, args, timeoutMs);
  }

  private async gitRemote(workspace: ScriptGitWorkspace, args: readonly string[], context: string): Promise<GitCommandResult> {
    const result = await this.runner.run(workspace.root, args, this.remoteTimeoutMs);
    if (result.exitCode === 0) return result;
    const detail = sanitizeGitOutput(result.stderr);
    throw new ScriptGitError("GIT_OPERATION_FAILED", `${context}${detail ? `：${detail}` : ""}`, 502);
  }

  private exclusive<T>(projectId: string, operation: (workspace: ScriptGitWorkspace) => Promise<T>): Promise<T> {
    let workspace: ScriptGitWorkspace;
    try {
      workspace = new ScriptGitWorkspace(this.options.dataDir, projectId);
    } catch (error) {
      return Promise.reject(error instanceof ScriptGitError
        ? error
        : new ScriptGitError("GIT_VALIDATION_FAILED", error instanceof Error ? error.message : "项目 ID 无效", 400));
    }
    const previous = this.projectQueues.get(projectId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => operation(workspace));
    const queue = task.then(() => undefined, () => undefined);
    this.projectQueues.set(projectId, queue);
    void queue.finally(() => { if (this.projectQueues.get(projectId) === queue) this.projectQueues.delete(projectId); });
    return task;
  }
}

function emptyStatus(): ScriptGitStatus {
  return {
    initialized: false,
    branch: DEFAULT_BRANCH,
    clean: true,
    changes: [],
    ahead: 0,
    behind: 0,
    remote: { configured: false, message: "尚未创建脚本版本记录" },
  };
}

function requireRemote(remote: ScriptGitRemoteState): Extract<ScriptGitRemoteState, { configured: true }> {
  if (!remote.configured) throw new ScriptGitError("GIT_REMOTE_REQUIRED", "未配置脚本远端，可继续使用本地提交记录", 409);
  return remote;
}

function validateCommitMessage(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw new ScriptGitError("GIT_VALIDATION_FAILED", "提交说明必须为 1-200 个单行字符", 400);
  }
}

function validateBranch(value: string): string {
  const branch = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch)
    || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")
    || branch.includes("..") || branch.includes("//") || branch.includes("@{")) {
    throw new ScriptGitError("GIT_VALIDATION_FAILED", "远端分支名称无效", 400);
  }
  return branch;
}

function validateRemoteUrl(value: string): string {
  const remote = value.trim();
  if (!remote || remote.length > 2_048 || remote.startsWith("-") || /[\s\0]/.test(remote)) {
    throw new ScriptGitError("GIT_VALIDATION_FAILED", "远端地址无效", 400);
  }
  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) return remote;
  try {
    const url = new URL(remote);
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash) throw new Error();
    if ((url.protocol === "https:" || url.protocol === "http:") && url.username) throw new Error();
    return remote;
  } catch {
    throw new ScriptGitError("GIT_VALIDATION_FAILED", "仅支持不含凭据的 HTTP(S)、SSH 或 git@host:path 远端地址", 400);
  }
}

function parseBranch(header: string): string {
  return header.replace(/^##\s*/, "").replace(/^No commits yet on\s+/, "").split("...")[0]?.trim() ?? "";
}

function parseCommit(line: string): ScriptGitCommit {
  const [hash = "", shortHash = "", author = "", committedAt = "", message = ""] = line.split("\x1f");
  return { hash, shortHash, author, committedAt, message };
}

function parseRemoteTree(output: string): RemoteTreeEntry[] {
  return output.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d{6})\s+(\w+)\s+[a-f0-9]+\t(.+)$/.exec(record);
    if (!match) throw new ScriptGitError("GIT_REMOTE_REJECTED", "远端 Git 树格式无效", 409);
    return { mode: match[1]!, type: match[2]!, path: match[3]!.replaceAll("\\", "/") };
  });
}
