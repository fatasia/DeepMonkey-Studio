import Fastify from "fastify";
import type { ScriptModule } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { registerScriptGitRoutes } from "./scriptGitRoutes.js";
import { ScriptGitError, type ScriptGitServiceContract, type ScriptGitStatus } from "./scriptGitTypes.js";
import type { MetadataStore } from "./store.js";

const cleanStatus: ScriptGitStatus = {
  initialized: true,
  branch: "main",
  clean: true,
  changes: [],
  ahead: 0,
  behind: 0,
  remote: { configured: false, message: "未配置" },
};

describe("script Git routes", () => {
  it("exposes status, commit, history and remote operations for an existing project", async () => {
    const service = serviceFixture();
    const app = Fastify();
    await registerScriptGitRoutes(app, { store: storeFixture(), service });
    expect((await app.inject({ method: "GET", url: "/api/projects/default/script-git/status" })).json()).toMatchObject({ branch: "main" });

    const scripts = [scriptFixture()];
    const commit = await app.inject({ method: "POST", url: "/api/projects/default/script-git/commits", payload: { scripts, message: "保存脚本" } });
    expect(commit.statusCode).toBe(200);
    expect(service.syncAndCommit).toHaveBeenCalledWith("default", scripts, "保存脚本");
    expect((await app.inject({ method: "GET", url: "/api/projects/default/script-git/history?limit=8" })).statusCode).toBe(200);
    expect(service.history).toHaveBeenCalledWith("default", 8);

    expect((await app.inject({ method: "PUT", url: "/api/projects/default/script-git/remote", payload: { url: "https://example.com/team/scripts.git", branch: "release" } })).statusCode).toBe(200);
    expect(service.configureRemote).toHaveBeenCalledWith("default", "https://example.com/team/scripts.git", "release");
    expect((await app.inject({ method: "POST", url: "/api/projects/default/script-git/pull" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/projects/default/script-git/push" })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/projects/default/script-git/remote" })).statusCode).toBe(200);
    await app.close();
  });

  it("validates inputs and maps recoverable Git conflicts without leaking details", async () => {
    const service = serviceFixture();
    vi.mocked(service.pull).mockRejectedValueOnce(new ScriptGitError("GIT_DIVERGED", "脚本历史已分叉，系统没有覆盖本地文件", 409));
    const app = Fastify();
    await registerScriptGitRoutes(app, { store: storeFixture(), service });
    expect((await app.inject({ method: "GET", url: "/api/projects/missing/script-git/status" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/bad%2Fid/script-git/status" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/projects/default/script-git/history?limit=99" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/projects/default/script-git/commits", payload: { scripts: [] } })).statusCode).toBe(400);

    const conflict = await app.inject({ method: "POST", url: "/api/projects/default/script-git/pull" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: "GIT_DIVERGED", message: "脚本历史已分叉，系统没有覆盖本地文件" });
    await app.close();
  });
});

function serviceFixture(): ScriptGitServiceContract {
  return {
    status: vi.fn(async () => cleanStatus),
    history: vi.fn(async () => []),
    syncAndCommit: vi.fn(async () => ({ committed: true, status: cleanStatus })),
    configureRemote: vi.fn(async () => cleanStatus),
    removeRemote: vi.fn(async () => cleanStatus),
    pull: vi.fn(async () => ({ updated: false, scripts: [], status: cleanStatus })),
    push: vi.fn(async () => ({ pushed: true, status: cleanStatus })),
  };
}

function storeFixture(): MetadataStore {
  return { getProject: (projectId: string) => projectId === "default" ? { id: "default" } : undefined } as MetadataStore;
}

function scriptFixture(): ScriptModule {
  return {
    id: "main",
    name: "主脚本",
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code: "export {};",
    lifecycle: ["onStart"],
    capabilities: [],
    permissions: ["scene.read"],
  };
}
