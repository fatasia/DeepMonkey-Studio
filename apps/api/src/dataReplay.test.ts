import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord, DataEvent } from "@bim-studio/contracts";
import { ALERT_EVENT_SOURCE } from "./alertRules.js";
import { registerDataReplayRoutes, type DataReplayPayload } from "./dataReplay.js";
import { DataEventBus } from "./dataEvents.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

const ROWS = [
  { recorded_at: "2026-09-19T00:00:00.000Z", temperature: 21.5, pressure: 101, label: "A" },
  { recorded_at: "2026-09-19T00:01:00.000Z", temperature: 22.5, pressure: 100, label: "B" },
  { recorded_at: "2026-09-19T00:02:00.000Z", temperature: 24, pressure: 99, label: "C" },
  { recorded_at: "not-a-date", temperature: 99, pressure: 98, label: "跳过" },
  { recorded_at: "2026-09-19T00:03:00.000Z", temperature: "文本", label: "无数值" },
];

async function createHarness(
  rows: Array<Record<string, unknown>> = ROWS,
  fields: DataDatasetRecord["fields"] = [
    { key: "recorded_at", label: "时间", type: "datetime" },
    { key: "temperature", label: "温度", type: "number" },
    { key: "pressure", label: "压力", type: "number" },
    { key: "label", label: "标签", type: "string" },
  ],
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-data-replay-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const project = await store.createProject("回放桥测试项目");
  const now = "2026-09-19T00:00:00.000Z";
  const connection: DataConnectionRecord = {
    id: "conn-1",
    projectId: project.id,
    name: "历史库",
    type: "csv",
    enabled: true,
    config: {},
    createdAt: now,
    updatedAt: now,
  };
  await store.saveDataConnection(project.id, connection);
  const dataset: DataDatasetRecord = {
    id: "ds-1",
    projectId: project.id,
    connectionId: connection.id,
    name: "传感器时序",
    refreshSeconds: 60,
    fields,
    createdAt: now,
    updatedAt: "2026-09-19T01:00:00.000Z",
  };
  await store.saveDataset(project.id, dataset);
  const bus = new DataEventBus();
  const app = createApiServer();
  await registerDataReplayRoutes(app, {
    store,
    bus,
    config: { dataDir } as never,
    readRows: async () => rows,
  });
  await app.ready();
  return {
    projectId: project.id,
    datasetUpdatedAt: dataset.updatedAt,
    bus,
    inject: (url: string) => app.inject({ method: "GET", url }),
  };
}

describe("data replay bridge", () => {
  it("builds a normalized numeric timeline from dataset rows with revision passthrough", async () => {
    const harness = await createHarness();
    const response = await harness.inject(`/api/projects/${harness.projectId}/data/replay?datasetId=ds-1`);
    expect(response.statusCode).toBe(200);
    const payload = response.json() as DataReplayPayload;
    expect(payload.revision).toBe(`dataset:ds-1@${harness.datasetUpdatedAt}`);
    // 无法解析的时间行与无数值行被如实跳过；其余按时间升序，非数值列不进 values。
    expect(payload.entries).toHaveLength(3);
    expect(payload.entries[0]).toEqual({ at: Date.parse("2026-09-19T00:00:00.000Z"), values: { temperature: 21.5, pressure: 101 } });
    expect(payload.entries[2]).toEqual({ at: Date.parse("2026-09-19T00:02:00.000Z"), values: { temperature: 24, pressure: 99 } });
  });

  it("applies windowMs to keep only the recent slice of the timeline", async () => {
    const harness = await createHarness();
    // 有效行只有 00:00/00:01/00:02（"not-a-date" 与无数值行被跳过），最新为 00:02；
    // windowMs=60000 → 保留 00:01 起的最近一分钟。
    const response = await harness.inject(`/api/projects/${harness.projectId}/data/replay?datasetId=ds-1&windowMs=60000`);
    expect(response.statusCode).toBe(200);
    const payload = response.json() as DataReplayPayload;
    expect(payload.entries.map((entry) => entry.at)).toEqual([
      Date.parse("2026-09-19T00:01:00.000Z"),
      Date.parse("2026-09-19T00:02:00.000Z"),
    ]);
  });

  it("returns 400 with actionable messages for empty, unknown and time-less datasets", async () => {
    const harness = await createHarness([]);
    const empty = await harness.inject(`/api/projects/${harness.projectId}/data/replay?datasetId=ds-1`);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toContain("可回放");

    const known = await createHarness();
    const unknownDataset = await known.inject(`/api/projects/${known.projectId}/data/replay?datasetId=missing`);
    expect(unknownDataset.statusCode).toBe(400);
    expect(unknownDataset.json().message).toContain("数据集不存在");

    const noTime = await createHarness(ROWS, [
      { key: "temperature", label: "温度", type: "number" },
      { key: "label", label: "标签", type: "string" },
    ]);
    const missingTime = await noTime.inject(`/api/projects/${noTime.projectId}/data/replay?datasetId=ds-1`);
    expect(missingTime.statusCode).toBe(400);
    expect(missingTime.json().message).toContain("时间列");

    expect((await harness.inject(`/api/projects/missing-project/data/replay`)).statusCode).toBe(404);
    expect((await known.inject(`/api/projects/${known.projectId}/data/replay?datasetId=ds-1&windowMs=-5`)).statusCode).toBe(400);
  });

  it("builds the timeline from retained bus events when no datasetId is given", async () => {
    const harness = await createHarness([]);
    const pid = harness.projectId;
    const event = (id: string, key: string, value: unknown, at: string, source = "mqtt/line-1"): DataEvent =>
      ({ id, projectId: pid, source, key, value, timestamp: at });
    harness.bus.publish(event("e1", "temperature", 21, "2026-09-19T00:00:00.000Z"));
    harness.bus.publish(event("e2", "reading", { temperature: 22, pressure: 100 }, "2026-09-19T00:01:00.000Z"));
    harness.bus.publish(event("e3", "temperature", 23, "2026-09-19T00:01:00.000Z"));
    harness.bus.publish(event("e4", "alert/x", { value: 99, status: "active" }, "2026-09-19T00:01:00.000Z", ALERT_EVENT_SOURCE));

    const response = await harness.inject(`/api/projects/${pid}/data/replay`);
    expect(response.statusCode).toBe(200);
    const payload = response.json() as DataReplayPayload;
    expect(payload.revision).toBe("events:4:e4");
    // 同刻事件合并进同一条目；告警引擎自产事件不进时间轴。
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[1]).toEqual({
      at: Date.parse("2026-09-19T00:01:00.000Z"),
      values: { temperature: 23, "reading.temperature": 22, "reading.pressure": 100 },
    });
  });

  it("returns 400 when neither retained events nor datasets provide data", async () => {
    const harness = await createHarness([]);
    const response = await harness.inject(`/api/projects/${harness.projectId}/data/replay`);
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("暂无可回放");
  });
});
