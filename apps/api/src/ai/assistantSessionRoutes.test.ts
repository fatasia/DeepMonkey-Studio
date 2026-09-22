import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../serverOptions.js";
import { AssistantSessionStore } from "./assistantSessionStore.js";
import { registerAssistantSessionRoutes } from "./assistantSessionRoutes.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
const base = "/api/projects/p/ai/assistant-sessions";
const turn = { sequence: 1, question: "检查泵", answer: "已读取", mode: "scene", status: "streaming", scope: "scene-1" };
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-session-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  async function open() {
    const sessions = new AssistantSessionStore(directory); await sessions.init();
    const app = createApiServer(); cleanup.push(() => app.close());
    app.addHook("preHandler", async request => {
      if (request.headers["x-user"] !== "anonymous") request.systemUser = { id: String(request.headers["x-user"] ?? "u1"), role: "viewer", projectIds: ["p", "p2"] } as never;
    });
    await registerAssistantSessionRoutes(app, sessions, id => ["p", "p2"].includes(id));
    return app;
  }
  return { directory, open, app: await open() };
}
describe("assistant session persistence", () => {
  it("persists bounded execution details while rejecting invalid protocols", async () => {
    const f = await fixture();
    await f.app.inject({ method: "PUT", url: `${base}/receipt`, payload: { title: "执行信息" } });
    const execution = { protocol: "responses", requestedModel: "alias", reportedModel: "snapshot", reasoningEffortSent: "high", servedBy: "fallback", failoverCategory: "rate-limit" };
    expect((await f.app.inject({ method: "PUT", url: `${base}/receipt/messages/m`, payload: { ...turn, execution } })).statusCode).toBe(200);
    const restored = await f.open();
    const body = (await restored.inject({ url: `${base}/receipt/messages` })).json();
    expect(body.messages[0].execution).toEqual(execution);
    expect((await f.app.inject({ method: "PUT", url: `${base}/receipt/messages/bad`, payload: { ...turn, execution: { ...execution, protocol: "other" } } })).statusCode).toBe(400);
  });
  it("persists the bounded reliability snapshot used by the answer evidence panel", async () => {
    const f = await fixture();
    await f.app.inject({ method: "PUT", url: `${base}/reliability`, payload: { title: "证据恢复" } });
    const reliability = {
      grade: "capability-verified", contextTrust: "server-evidence", inputRisk: "low", writePolicy: "read-only",
      evidenceCount: 2, warnings: [], sourceLabels: ["设备数据"], contextSourceLabels: { datasets: "设备数据" },
      traceId: "trace-1", contextFingerprint: "sha256:abc",
      contextDelivery: { unit: "utf16", preparedChars: 20, sentChars: 18, sources: [{ id: "datasets", path: "platform.datasets", status: "sent", preparedChars: 20, sentChars: 18, transformed: false }] },
    };
    expect((await f.app.inject({ method: "PUT", url: `${base}/reliability/messages/m`, payload: { ...turn, reliability } })).statusCode).toBe(200);
    const restored = (await f.app.inject({ url: `${base}/reliability/messages` })).json();
    expect(restored.messages[0].reliability).toEqual(reliability);
    expect((await f.app.inject({ method: "PUT", url: `${base}/reliability/messages/bad`, payload: { ...turn, reliability: { ...reliability, evidenceCount: -1 } } })).statusCode).toBe(400);
  });
  it("isolates owners/projects and restores partial/complete/stopped turns after restart", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: base, headers: { "x-user": "anonymous" } })).statusCode).toBe(401);
    expect((await f.app.inject({ url: base.replace("/p/", "/foreign/") })).statusCode).toBe(403);
    const created = await f.app.inject({ method: "PUT", url: `${base}/s1`, payload: { title: "泵检查", owner: "forged", apiKey: "do-not-store" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).not.toHaveProperty("owner");
    for (const [id, status] of [["m1", "streaming"], ["m2", "completed"], ["m3", "stopped"]]) {
      expect((await f.app.inject({ method: "PUT", url: `${base}/s1/messages/${id}`, payload: { ...turn, status, context: { privateSource: "do-not-store" } } })).statusCode).toBe(200);
    }
    const before = (await f.app.inject({ url: `${base}/s1/messages` })).json();
    expect(before.messages[0].status).toBe("streaming");
    expect((await f.app.inject({ url: `${base}/s1/messages`, headers: { "x-user": "u2" } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "PUT", url: `${base}/s1`, headers: { "x-user": "u2" }, payload: { title: "覆盖" } })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `${base}/s1/messages`.replace("/p/", "/p2/") })).statusCode).toBe(404);
    expect((await f.app.inject({ url: base, headers: { "x-user": "u2" } })).json().items).toEqual([]);
    await f.app.close();
    const resumed = await f.open();
    const recovered = (await resumed.inject({ url: `${base}/s1/messages` })).json();
    expect(recovered.messages.map((message: { status: string }) => message.status)).toEqual(["interrupted", "completed", "stopped"]);
    expect(recovered.messages[0]).toMatchObject({ answer: "已读取", scope: "scene-1", createdAt: before.messages[0].createdAt });
    expect(recovered.messages[1]).toEqual(before.messages[1]);
    expect(await readFile(path.join(f.directory, "assistant-sessions.json"), "utf8")).not.toContain("do-not-store");
  });

  it("makes sequence retries idempotent and paginates append-only order despite updates", async () => {
    const { app } = await fixture();
    for (const id of ["s1", "s2", "s3"]) await app.inject({ method: "PUT", url: `${base}/${id}`, payload: { title: id } });
    expect((await app.inject({ url: `${base}?limit=2` })).json()).toMatchObject({ items: [{ id: "s3" }, { id: "s2" }], nextCursor: "s2" });
    await app.inject({ method: "PUT", url: `${base}/s4`, payload: { title: "新增会话" } });
    expect((await app.inject({ url: `${base}?limit=2&after=s2` })).json().items.map((s: { id: string }) => s.id)).toEqual(["s1"]);
    const url = `${base}/s1/messages/m1`;
    const responses = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: "PUT", url, payload: turn })));
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    for (const response of responses) expect(response.json()).toEqual(responses[0]!.json());
    expect((await app.inject({ method: "PUT", url, payload: { ...turn, answer: "同序号不同内容" } })).statusCode).toBe(409);
    await app.inject({ method: "PUT", url: `${base}/s1/messages/m2`, payload: turn });
    const stopped = { ...turn, sequence: 2, answer: "停止前结果", status: "stopped" };
    expect((await app.inject({ method: "PUT", url, payload: stopped })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url, payload: { ...stopped, sequence: 3, status: "streaming" } })).statusCode).toBe(409);
    expect((await app.inject({ url: `${base}/s1/messages?limit=1` })).json()).toMatchObject({ messages: [{ id: "m1", status: "stopped" }], nextCursor: "m1" });
    expect((await app.inject({ url: `${base}/s1/messages?limit=1&after=m1` })).json().messages.map((m: { id: string }) => m.id)).toEqual(["m2"]);
    for (const query of ["limit=0", "limit=51", "after=missing"]) expect((await app.inject({ url: `${base}/s1/messages?${query}` })).statusCode).toBe(400);
    for (const payload of [{ ...turn, sequence: -1 }, { ...turn, mode: ["scene"] }, { ...turn, answer: "x".repeat(100_001) }, { ...turn, status: "interrupted" }]) expect((await app.inject({ method: "PUT", url, payload })).statusCode).toBe(400);
  });
});
