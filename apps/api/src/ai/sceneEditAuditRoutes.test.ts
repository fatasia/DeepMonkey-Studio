import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../serverOptions.js";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";
import { registerSceneEditAuditRoutes } from "./sceneEditAuditRoutes.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map(close => close())));

async function setup(role = "editor") {
  const audit = new AiReliabilityAuditBuffer();
  const app = createApiServer();
  closers.push(() => app.close());
  app.addHook("preHandler", async (request) => { request.systemUser = { id: "u1", role } as never; });
  await registerSceneEditAuditRoutes(app, { store: { getProject: (id: string) => id === "p1" ? ({ id: "p1" } as never) : undefined }, audit: audit.sink });
  return { app, audit };
}
const record = (extra: Record<string, unknown> = {}) => ({
  sessionId: "se-abc1", round: 1, event: "applied", mode: "confirm", planFingerprint: "ab12cd34", commandCount: 3,
  receiptId: "se-abc1-r1", checks: { total: 12, failed: 0 }, viewportFingerprint: "deadbeefcafef00d", ...extra,
});
const post = (app: Awaited<ReturnType<typeof setup>>["app"], payload: unknown, project = "p1") =>
  app.inject({ method: "POST", url: `/api/projects/${project}/ai/scene-edit-records`, payload: payload as never });

describe("scene edit audit records", () => {
  it("writes fingerprint-only tool-result evidence bound to the principal and project", async () => {
    const { app, audit } = await setup();
    const response = await post(app, record());
    expect(response.statusCode).toBe(202);
    const [event] = audit.list();
    expect(event).toMatchObject({
      stage: "tool-result", outcome: "completed", principal: "u1", projectId: "p1", traceId: "scene-edit:se-abc1:1",
      tool: { id: "scene.edit.applied", risk: "medium", resourceFingerprints: ["ab12cd34", "deadbeefcafef00d"] },
    });
    expect(JSON.stringify(event)).not.toContain("离心泵");
    expect(response.json().evidenceFingerprint).toBe(event!.evidenceFingerprint);
  });

  it("marks rollbacks as failed and unmet verdicts as degraded", async () => {
    const { app, audit } = await setup();
    await post(app, record({ event: "rolled-back" }));
    await post(app, record({ event: "verified", verdict: { outcome: "unachieved", source: "model" } }));
    await post(app, record({ event: "verified", verdict: { outcome: "achieved", source: "model" } }));
    await post(app, record({ event: "undone" }));
    expect(audit.list().map(item => item.outcome)).toEqual(["failed", "degraded", "completed", "completed"]);
    expect(audit.list()[0]!.failure).toMatchObject({ code: "scene-edit-rolled-back" });
  });

  it("rejects viewers, unknown projects and malformed bodies without writing audit", async () => {
    const viewer = await setup("viewer");
    expect((await post(viewer.app, record())).statusCode).toBe(403);
    const { app, audit } = await setup();
    expect((await post(app, record(), "missing")).statusCode).toBe(404);
    for (const bad of [{ ...record(), event: "hack" }, { ...record(), planFingerprint: "xyz" }, { ...record(), round: 99 }, { ...record(), sessionId: "../x" }, { ...record(), commandCount: 65 }, { ...record(), verdict: { outcome: "?", source: "model" } }, [1]]) {
      expect((await post(app, bad)).statusCode).toBe(400);
    }
    expect(audit.list()).toHaveLength(0);
  });
});
