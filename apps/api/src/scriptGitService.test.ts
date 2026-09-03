import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScriptModule } from "@bim-studio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { NativeGitCommandRunner } from "./scriptGitProcess.js";
import { ScriptGitService } from "./scriptGitService.js";
import { ScriptGitError, type ScriptGitManifest } from "./scriptGitTypes.js";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("ScriptGitService", () => {
  it("stores only deterministic script files and creates concise local history", async () => {
    const dataDir = await temporaryDirectory("bim-script-git-");
    const service = new ScriptGitService({ dataDir, commandTimeoutMs: 5_000 });
    expect(await service.status("default")).toMatchObject({ initialized: false, clean: true, remote: { configured: false } });

    const first = await service.syncAndCommit("default", [script("scene-main", "主控制", "export const speed = 1;"), script("alarm", "告警", "export const alarm = true;")], "初始化脚本");
    expect(first).toMatchObject({ committed: true, commit: { message: "初始化脚本" }, status: { initialized: true, clean: true } });

    const workspace = projectWorkspace(dataDir);
    const files = (await readdir(path.join(workspace, "scripts"))).sort();
    expect(files).toEqual([
      "manifest.json",
      "script-5e94ec139442cfe9.js",
      "script-759c5d829f07e150.js",
    ]);
    const manifest = JSON.parse(await readFile(path.join(workspace, "scripts", "manifest.json"), "utf8")) as ScriptGitManifest;
    expect(manifest.scripts.map(({ id, name, file }) => ({ id, name, file }))).toEqual([
      { id: "scene-main", name: "主控制", file: "script-759c5d829f07e150.js" },
      { id: "alarm", name: "告警", file: "script-5e94ec139442cfe9.js" },
    ]);
    expect((await service.history("default", 10)).map((commit) => commit.message)).toEqual(["初始化脚本"]);

    const unchanged = await service.syncAndCommit("default", [script("scene-main", "主控制", "export const speed = 1;"), script("alarm", "告警", "export const alarm = true;")], "不会产生空提交");
    expect(unchanged.committed).toBe(false);
    await service.syncAndCommit("default", [script("scene-main", "主控制", "export const speed = 2;")], "调整速度并删除告警脚本");
    expect(await readdir(path.join(workspace, "scripts"))).toEqual(expect.arrayContaining(["manifest.json", "script-759c5d829f07e150.js"]));
    expect(await readdir(path.join(workspace, "scripts"))).not.toContain("script-5e94ec139442cfe9.js");
    expect((await service.history("default", 2)).map((commit) => commit.message)).toEqual(["调整速度并删除告警脚本", "初始化脚本"]);
  }, 20_000);

  it("rejects credentials, missing remotes, unsafe paths and oversized input", async () => {
    const dataDir = await temporaryDirectory("bim-script-git-guard-");
    const service = new ScriptGitService({ dataDir });
    const credentialFailure = service.configureRemote("default", "https://user:secret@example.com/repo.git", "main");
    await expect(credentialFailure).rejects.toMatchObject({ code: "GIT_VALIDATION_FAILED" });
    await expect(credentialFailure).rejects.not.toThrow("secret");
    await service.syncAndCommit("default", [script("main", "主脚本", "export {};" )], "本地版本");
    await expect(service.push("default")).rejects.toMatchObject({ code: "GIT_REMOTE_REQUIRED" });
    expect(await service.configureRemote("default", "https://example.com/team/scripts.git", "release/v1")).toMatchObject({
      remote: { configured: true, url: "https://example.com/team/scripts.git", branch: "release/v1" },
    });
    expect(await service.removeRemote("default")).toMatchObject({ remote: { configured: false } });

    await writeFile(path.join(projectWorkspace(dataDir), "README.md"), "not allowed");
    await expect(service.syncAndCommit("default", [script("main", "主脚本", "export const value = 2;")], "非法工作区"))
      .rejects.toMatchObject({ code: "GIT_VALIDATION_FAILED", message: expect.stringContaining("README.md") });
    await expect(service.syncAndCommit("other", [script("bad/id", "越界", "")], "非法 ID"))
      .rejects.toMatchObject({ code: "GIT_VALIDATION_FAILED" });
  }, 20_000);

  it("pushes and fast-forwards through a local bare repository without network access", async () => {
    const dataDir = await temporaryDirectory("bim-script-git-remote-");
    const remote = await temporaryDirectory("bim-script-git-bare-");
    const peer = `${remote}-peer`;
    directories.push(peer);
    await git(path.dirname(remote), "init", "--bare", remote);
    const service = new ScriptGitService({ dataDir, remoteTimeoutMs: 10_000 });
    const initialScript = script("main", "主脚本", "export const value = 1;");
    await service.syncAndCommit("default", [initialScript], "初始版本");
    const workspace = projectWorkspace(dataDir);
    await git(workspace, "remote", "add", "origin", remote);
    await git(workspace, "config", "bim-studio.remoteBranch", "main");
    expect((await service.push("default")).pushed).toBe(true);
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await git(path.dirname(remote), "clone", remote, peer);
    await git(peer, "config", "user.name", "Peer");
    await git(peer, "config", "user.email", "peer@example.test");

    const file = (JSON.parse(await readFile(path.join(peer, "scripts", "manifest.json"), "utf8")) as ScriptGitManifest).scripts[0]!.file;
    await writeFile(path.join(peer, "scripts", file), "export const value = 2;");
    await git(peer, "add", "--", "scripts");
    await git(peer, "commit", "-m", "远端更新");
    await git(peer, "push", "origin", "main");
    const pulled = await service.pull("default");
    expect(pulled.updated).toBe(true);
    // Git 清单与独立 JS 文件必须无损还原完整 ScriptModule，而非只找回代码文本。
    expect(pulled.scripts).toEqual([{ ...initialScript, code: "export const value = 2;" }]);

    await service.syncAndCommit("default", [script("main", "主脚本", "export const value = 'local';")], "本地分支更新");
    await writeFile(path.join(peer, "scripts", file), "export const value = 3;");
    await git(peer, "add", "--", "scripts");
    await git(peer, "commit", "-m", "远端分支更新");
    await git(peer, "push", "origin", "main");
    const localDivergedHead = await git(workspace, "rev-parse", "HEAD");
    await expect(service.pull("default")).rejects.toMatchObject({
      code: "GIT_DIVERGED",
      message: expect.stringContaining("没有重置或覆盖"),
    });
    expect((await git(workspace, "rev-parse", "HEAD")).stdout).toBe(localDivergedHead.stdout);
    expect(await readFile(path.join(workspace, "scripts", file), "utf8")).toBe("export const value = 'local';");

    await writeFile(path.join(peer, "README.md"), "outside scripts");
    await git(peer, "add", "README.md");
    await git(peer, "commit", "-m", "远端非法文件");
    await git(peer, "push", "origin", "main");
    const beforeHead = await git(workspace, "rev-parse", "HEAD");
    await expect(service.pull("default")).rejects.toMatchObject({ code: "GIT_REMOTE_REJECTED" });
    expect((await git(workspace, "rev-parse", "HEAD")).stdout).toBe(beforeHead.stdout);
    await expect(readFile(path.join(workspace, "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("times out a blocked process and reports that no reset was attempted", async () => {
    const root = await temporaryDirectory("bim-script-git-timeout-");
    const runner = new NativeGitCommandRunner(process.execPath, 25);
    await expect(runner.run(root, ["-e", "setTimeout(() => {}, 5000)"]))
      .rejects.toEqual(expect.objectContaining<Partial<ScriptGitError>>({ code: "GIT_TIMEOUT", statusCode: 504 }));
  });
});

function script(id: string, name: string, code: string): ScriptModule {
  return {
    id,
    name,
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code,
    lifecycle: ["onStart", "onUpdate", "onData", "onDispose"],
    capabilities: ["studio.runtime"],
    permissions: ["scene.read", "data.write", "network.connect"],
    target: { kind: "scene" },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function projectWorkspace(dataDir: string): string {
  return path.join(dataDir, "projects", "default", "script-git");
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execute("git", args, { cwd, windowsHide: true });
}
