import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AlertRuleFileStore, AlertRuleRuntime, registerAlertRuleRoutes } from "./alertRules.js";
import { registerDataEventRoutes } from "./dataEvents.js";
import { registerDataReplayRoutes } from "./dataReplay.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { registerSystemRoutes } from "./system.js";

const directories: string[] = [];
const applications: FastifyInstance[] = [];
const runtimes: AlertRuleRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  await Promise.all(applications.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("authenticated monitoring data flow", () => {
  it("connects ingestion, alert evaluation, replay and acknowledgement under project permissions", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-monitoring-flow-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    applications.push(app);

    await registerSystemRoutes(app, store, dataDir);
    const bus = await registerDataEventRoutes(app, store);
    const runtime = new AlertRuleRuntime({ bus, ruleStore: new AlertRuleFileStore(dataDir) });
    runtimes.push(runtime);
    await registerAlertRuleRoutes(app, store, runtime);
    await registerDataReplayRoutes(app, { store, bus, config: { dataDir } as never });
    await app.ready();

    const anonymous = await app.inject({ method: "GET", url: "/api/projects/default/alert-state" });
    expect(anonymous.statusCode).toBe(401);

    const adminToken = await login(app, "admin", "admin");
    const adminHeaders = authorization(adminToken);
    const createdRule = await app.inject({
      method: "POST",
      url: "/api/projects/default/alert-rules",
      headers: adminHeaders,
      payload: {
        label: "轴承高温",
        signalId: "bearing.temperature",
        kind: "threshold-above",
        threshold: 80,
        severity: "alarm",
        hysteresis: 5,
      },
    });
    expect(createdRule.statusCode).toBe(201);
    const ruleId = createdRule.json().id as string;

    const ingested = await app.inject({
      method: "POST",
      url: "/api/projects/default/data/events",
      headers: adminHeaders,
      payload: {
        id: "telemetry-1",
        source: "mqtt/line-1",
        key: "bearing",
        value: { temperature: 91, vibration: 2.4 },
        timestamp: "2026-09-20T08:00:00.000Z",
      },
    });
    expect(ingested.statusCode).toBe(202);

    const state = await app.inject({ method: "GET", url: "/api/projects/default/alert-state", headers: adminHeaders });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      ok: true,
      states: [{ ruleId, status: "active", lastValue: 91 }],
    });

    const replay = await app.inject({ method: "GET", url: "/api/projects/default/data/replay", headers: adminHeaders });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      revision: expect.stringContaining("events:"),
      entries: [{
        at: Date.parse("2026-09-20T08:00:00.000Z"),
        values: { "bearing.temperature": 91, "bearing.vibration": 2.4 },
      }],
    });

    await createUser(app, adminHeaders, "monitor-viewer", "viewer", ["default"]);
    await createUser(app, adminHeaders, "foreign-editor", "editor", ["other-project"]);
    const viewerHeaders = authorization(await login(app, "monitor-viewer", "fixture-password"));
    const foreignHeaders = authorization(await login(app, "foreign-editor", "fixture-password"));

    expect((await app.inject({ method: "GET", url: "/api/projects/default/data/replay", headers: viewerHeaders })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/projects/default/alert-rules/${ruleId}/acknowledge`,
      headers: viewerHeaders,
      payload: {},
    })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/projects/default/alert-state", headers: foreignHeaders })).statusCode).toBe(403);

    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/projects/default/alert-rules/${ruleId}/acknowledge`,
      headers: adminHeaders,
      payload: {},
    });
    expect(acknowledged.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/projects/default/alert-state", headers: adminHeaders })).json())
      .toMatchObject({ states: [{ ruleId, status: "acknowledged" }] });
  });
});

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createUser(
  app: FastifyInstance,
  headers: { authorization: string },
  username: string,
  role: "viewer" | "editor",
  projectIds: string[],
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/users",
    headers,
    payload: { username, password: "fixture-password", role, projectIds },
  });
  expect(response.statusCode).toBe(201);
}
