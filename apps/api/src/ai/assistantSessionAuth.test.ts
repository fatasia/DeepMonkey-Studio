import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { StoredSystemUserRecord } from "@bim-studio/contracts";
import type { MetadataStore } from "../store.js";
import { createApiServer } from "../serverOptions.js";
import { registerSystemRoutes } from "../system.js";

it("permits a signed-in viewer to persist only their own project conversation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-session-auth-"));
  const users = new Map<string, StoredSystemUserRecord>();
  const metadata = {
    listUsers: () => [...users.values()], getUser: (id: string) => users.get(id),
    findUserByUsername: (username: string) => [...users.values()].find(user => user.username === username),
    saveUser: async (user: StoredSystemUserRecord) => { users.set(user.id, user); return user; },
    addAuditLog: async () => undefined, getBrandingSettings: () => undefined,
    getProject: (id: string) => ["p", "other"].includes(id) ? { id } : undefined,
  } as unknown as MetadataStore;
  const app = createApiServer();
  try {
    await registerSystemRoutes(app, metadata, directory);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
    const headers = { authorization: `Bearer ${login.json().token}` };
    for (const user of users.values()) { user.role = "viewer"; user.projectIds = ["p"]; }
    const url = "/api/projects/p/ai/assistant-sessions/session";
    expect((await app.inject({ method: "PUT", url, payload: { title: "会话" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url, headers, payload: { title: "会话" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `${url}/messages/turn`, headers, payload: { sequence: 1, question: "检查", answer: "已读取", mode: "scene", status: "stopped" } })).statusCode).toBe(200);
    expect((await app.inject({ url: `${url}/messages`, headers })).json().messages[0].status).toBe("stopped");
    expect((await app.inject({ method: "PUT", url: url.replace("/p/", "/other/"), headers, payload: { title: "越权" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/projects/p/ai/agent-runs", headers, payload: { objective: "运行" } })).statusCode).toBe(403);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
