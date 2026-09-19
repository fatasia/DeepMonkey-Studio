import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataEvent } from "@bim-studio/contracts";
import { ALERT_EVENT_SOURCE, AlertRuleFileStore, AlertRuleRuntime, registerAlertRuleRoutes } from "./alertRules.js";
import { DataEventBus } from "./dataEvents.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

interface Harness {
  dataDir: string;
  projectId: string;
  bus: DataEventBus;
  runtime: AlertRuleRuntime;
  alarms: DataEvent[];
  inject: (method: string, url: string, payload?: unknown) => Promise<{ statusCode: number; json: () => any }>;
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-alert-rules-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const project = await store.createProject("告警桥测试项目");
  const bus = new DataEventBus();
  const runtime = new AlertRuleRuntime({ bus, ruleStore: new AlertRuleFileStore(dataDir) });
  const app = createApiServer();
  await registerAlertRuleRoutes(app, store, runtime);
  await app.ready();
  const alarms: DataEvent[] = [];
  bus.subscribe(project.id, undefined, (event) => {
    // 只收集引擎产出（value 带 ruleId）；外部手工注入的 alert-engine 事件不算。
    if (event.source === ALERT_EVENT_SOURCE && (event.value as { ruleId?: string } | null)?.ruleId !== undefined) alarms.push(event);
  });
  return {
    dataDir,
    projectId: project.id,
    bus,
    runtime,
    alarms,
    inject: (method, url, payload) => app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }),
  };
}

function dataEvent(projectId: string, key: string, value: unknown, at: string, source = "sensor"): DataEvent {
  return { id: `${key}-${at}-${source}`, projectId, source, key, value, timestamp: at };
}

async function createTemperatureRule(harness: Harness): Promise<string> {
  const response = await harness.inject("POST", `/api/projects/${harness.projectId}/alert-rules`, {
    label: "高温告警",
    signalId: "temperature",
    kind: "threshold-above",
    threshold: 80,
    severity: "alarm",
    hysteresis: 5,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

describe("alert rule routes", () => {
  it("creates, lists and deletes rules with JSON file persistence", async () => {
    const harness = await createHarness();
    const ruleId = await createTemperatureRule(harness);

    const persisted = JSON.parse(await readFile(path.join(harness.dataDir, "projects", harness.projectId, "alert-rules.json"), "utf8"));
    expect(persisted.rules).toHaveLength(1);
    expect(persisted.rules[0]).toMatchObject({ id: ruleId, signalId: "temperature", threshold: 80, hysteresis: 5 });

    const listed = await harness.inject("GET", `/api/projects/${harness.projectId}/alert-rules`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const removed = await harness.inject("DELETE", `/api/projects/${harness.projectId}/alert-rules/${ruleId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, removed: true });
    expect((await harness.inject("GET", `/api/projects/${harness.projectId}/alert-rules`)).json()).toHaveLength(0);
    expect((await harness.inject("DELETE", `/api/projects/${harness.projectId}/alert-rules/${ruleId}`)).statusCode).toBe(404);
  });

  it("rejects invalid rules with actionable Chinese messages", async () => {
    const harness = await createHarness();
    const missingLabel = await harness.inject("POST", `/api/projects/${harness.projectId}/alert-rules`, {
      signalId: "temperature", kind: "threshold-above", threshold: 80, severity: "alarm",
    });
    expect(missingLabel.statusCode).toBe(400);
    expect(missingLabel.json().message).toContain("label");

    const badKind = await harness.inject("POST", `/api/projects/${harness.projectId}/alert-rules`, {
      label: "x", signalId: "temperature", kind: "inside-range", threshold: 80, severity: "alarm",
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().message).toContain("threshold-above");

    const negativeHysteresis = await harness.inject("POST", `/api/projects/${harness.projectId}/alert-rules`, {
      label: "x", signalId: "temperature", kind: "threshold-above", threshold: 80, severity: "alarm", hysteresis: -1,
    });
    expect(negativeHysteresis.statusCode).toBe(400);
    expect(negativeHysteresis.json().message).toContain("hysteresis");

    expect((await harness.inject("POST", "/api/projects/does-not-exist/alert-rules", {})).statusCode).toBe(404);
  });

  it("returns 404 for unknown projects on read routes", async () => {
    const harness = await createHarness();
    expect((await harness.inject("GET", "/api/projects/does-not-exist/alert-rules")).statusCode).toBe(404);
    expect((await harness.inject("GET", "/api/projects/does-not-exist/alert-state")).statusCode).toBe(404);
  });
});

describe("alert evaluation bridge", () => {
  it("publishes alarm lifecycle events back onto the bus with severity and status", async () => {
    const harness = await createHarness();
    const ruleId = await createTemperatureRule(harness);
    const pid = harness.projectId;

    harness.bus.publish(dataEvent(pid, "temperature", 81, "2026-09-19T00:00:01.000Z"));
    expect(harness.alarms).toHaveLength(1);
    expect(harness.alarms[0]).toMatchObject({
      projectId: pid,
      source: ALERT_EVENT_SOURCE,
      key: `alert/${ruleId}`,
      action: "alarm",
      timestamp: "2026-09-19T00:00:01.000Z",
    });
    expect(harness.alarms[0]!.value).toMatchObject({
      state: "alarm", active: true, severity: "critical", acknowledged: false, status: "active", value: 81,
    });

    let state = await harness.inject("GET", `/api/projects/${pid}/alert-state`);
    expect(state.json().states[0]).toMatchObject({ ruleId, status: "active", lastValue: 81 });

    // 迟滞：78 仍高于阈值但未回落到 threshold - hysteresis(75)，保持激活且不重复发事件。
    harness.bus.publish(dataEvent(pid, "temperature", 78, "2026-09-19T00:00:02.000Z"));
    expect(harness.alarms).toHaveLength(1);
    expect((await harness.inject("GET", `/api/projects/${pid}/alert-state`)).json().states[0].status).toBe("active");

    harness.bus.publish(dataEvent(pid, "temperature", 74, "2026-09-19T00:00:03.000Z"));
    expect(harness.alarms).toHaveLength(2);
    expect(harness.alarms[1]!.value).toMatchObject({ state: "normal", active: false, status: "cleared", value: 74 });
    expect((await harness.inject("GET", `/api/projects/${pid}/alert-state`)).json().states[0].status).toBe("cleared");
  });

  it("acknowledges an active alarm and broadcasts the acknowledged event", async () => {
    const harness = await createHarness();
    const ruleId = await createTemperatureRule(harness);
    const pid = harness.projectId;

    harness.bus.publish(dataEvent(pid, "temperature", 90, "2026-09-19T00:00:01.000Z"));
    expect(harness.alarms).toHaveLength(1);

    const acknowledged = await harness.inject("POST", `/api/projects/${pid}/alert-rules/${ruleId}/acknowledge`);
    expect(acknowledged.statusCode).toBe(200);
    expect(harness.alarms).toHaveLength(2);
    expect(harness.alarms[1]!.value).toMatchObject({ status: "acknowledged", acknowledged: true, active: true, state: "alarm" });
    expect((await harness.inject("GET", `/api/projects/${pid}/alert-state`)).json().states[0].status).toBe("acknowledged");

    const again = await harness.inject("POST", `/api/projects/${pid}/alert-rules/${ruleId}/acknowledge`);
    expect(again.statusCode).toBe(409);
    expect(harness.alarms).toHaveLength(2);
  });

  it("ignores self-published alarm events and non-numeric signals without feedback loops", async () => {
    const harness = await createHarness();
    await createTemperatureRule(harness);
    const pid = harness.projectId;

    harness.bus.publish({
      ...dataEvent(pid, "alert/x", { value: 99, status: "active" }, "2026-09-19T00:00:01.000Z"),
      source: ALERT_EVENT_SOURCE,
      action: "alarm",
    });
    harness.bus.publish(dataEvent(pid, "temperature", "not-a-number", "2026-09-19T00:00:02.000Z"));
    harness.bus.publish(dataEvent(pid, "temperature", { unit: "°C" }, "2026-09-19T00:00:03.000Z"));
    harness.bus.publish(dataEvent(pid, "temperature", true, "2026-09-19T00:00:04.000Z"));

    expect(harness.alarms).toHaveLength(0);
    expect((await harness.inject("GET", `/api/projects/${pid}/alert-state`)).json().states).toHaveLength(0);
  });

  it("evaluates object-valued events via key.name signal paths", async () => {
    const harness = await createHarness();
    await harness.inject("POST", `/api/projects/${harness.projectId}/alert-rules`, {
      label: "低压告警",
      signalId: "readings.pressure",
      kind: "threshold-below",
      threshold: 50,
      severity: "warning",
    });
    harness.bus.publish(dataEvent(harness.projectId, "readings", { pressure: 42, temperature: 20 }, "2026-09-19T00:00:01.000Z"));
    expect(harness.alarms).toHaveLength(1);
    expect(harness.alarms[0]!.value).toMatchObject({ state: "warning", severity: "warning", status: "active", value: 42 });
  });

  it("reloads persisted rules into a fresh runtime after restart", async () => {
    const harness = await createHarness();
    await createTemperatureRule(harness);
    harness.runtime.dispose();

    const restarted = new AlertRuleRuntime({ bus: harness.bus, ruleStore: new AlertRuleFileStore(harness.dataDir) });
    const rules = await restarted.listRules(harness.projectId);
    expect(rules).toHaveLength(1);

    harness.bus.publish(dataEvent(harness.projectId, "temperature", 95, "2026-09-19T00:00:01.000Z"));
    expect(harness.alarms).toHaveLength(1);
    expect((await restarted.states(harness.projectId))[0]?.status).toBe("active");
    restarted.dispose();
  });

  it("resets evaluation state when rules change", async () => {
    const harness = await createHarness();
    const ruleId = await createTemperatureRule(harness);
    harness.bus.publish(dataEvent(harness.projectId, "temperature", 90, "2026-09-19T00:00:01.000Z"));
    expect((await harness.inject("GET", `/api/projects/${harness.projectId}/alert-state`)).json().states[0].status).toBe("active");

    await harness.inject("DELETE", `/api/projects/${harness.projectId}/alert-rules/${ruleId}`);
    expect((await harness.inject("GET", `/api/projects/${harness.projectId}/alert-state`)).json().states).toHaveLength(0);
  });
});
