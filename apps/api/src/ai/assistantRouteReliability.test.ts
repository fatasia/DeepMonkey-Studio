import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { StoredSystemUserRecord } from "@bim-studio/contracts";
import { createApiServer } from "../serverOptions.js";
import type { MetadataStore } from "../store.js";
import { registerSystemRoutes } from "../system.js";
import { AiReliabilityBlockedError, type AssistantService } from "./assistantService.js";

describe("AI assistant HTTP reliability boundary", () => {
  it.each(["/api/ai/assistant", "/api/ai/assistant/stream"])("maps blocked input to a structured 403 before model output: %s", async (url) => {
    const store = inMemorySystemStore();
    const app = createApiServer();
    await registerSystemRoutes(app, store, tmpdir(), { assistant: blockedAssistant() });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
    const token = login.json().token as string;
    const response = await app.inject({
      method: "POST", url, headers: { authorization: `Bearer ${token}` },
      payload: { mode: "platform", question: "malicious", context: {}, projectId: "default" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      message: "请求包含暴露敏感信息或绕过工具审批的高风险指令，已停止处理",
      code: "ai-input-blocked", traceId: "trace-blocked", findings: ["secret-exfiltration"],
    });
    await app.close();
  });
});

function blockedAssistant(): AssistantService {
  return {
    async complete() { throw new AiReliabilityBlockedError("trace-blocked", ["secret-exfiltration"]); },
    async *stream() { throw new AiReliabilityBlockedError("trace-blocked", ["secret-exfiltration"]); },
  };
}

function inMemorySystemStore(): MetadataStore {
  const users = new Map<string, StoredSystemUserRecord>();
  return {
    listUsers: () => [...users.values()],
    getUser: (id: string) => users.get(id),
    findUserByUsername: (username: string) => [...users.values()].find((item) => item.username === username),
    saveUser: async (user: StoredSystemUserRecord) => { users.set(user.id, user); return user; },
    addAuditLog: async () => undefined,
    getProject: (id: string) => id === "default" ? { id: "default" } : undefined,
    getAiSettings: () => ({ providerId: "ai.test", baseUrl: "https://example.test/v1", model: "test", protocol: "auto", temperature: 0, apiKey: "test" }),
    getBrandingSettings: () => undefined,
  } as unknown as MetadataStore;
}
