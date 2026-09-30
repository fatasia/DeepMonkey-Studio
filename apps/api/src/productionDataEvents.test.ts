import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assessEventRecording, type EventRecordingFile } from "@bim-studio/contracts";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";
import { registerProductionDataEvents } from "./productionDataEvents.js";

const roots: string[] = [];
const servers: ReturnType<typeof createApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it("production registration persists gaps and a manual reopen across server instances, preserving the existing event bus", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "c4-production-")); roots.push(dir);
  const store = new JsonStore(dir); await store.init();
  const project = await store.createProject("C4 production");
  const openServer = async () => {
    const app = createApiServer(); servers.push(app);
    const bus = await registerProductionDataEvents(app, store, dir);
    await app.ready(); return { app, bus };
  };
  const { app, bus } = await openServer();
  const base = `/api/projects/${project.id}/data/recordings`;
  const opened = await app.inject({ method: "POST", url: base, payload: { recordingId: "rec-production", sourceOrigin: "injected" } });
  expect(opened.statusCode).toBe(201);
  for (const sequence of [1, 3, 2]) {
    const recorded = await app.inject({ method: "POST", url: `${base}/rec-production/record`, payload: { source: "manual", key: "temperature", value: 27, sequence } });
    expect(recorded.statusCode).toBe(202);
  }
  expect((await app.inject({ method: "POST", url: `${base}/rec-production/close` })).statusCode).toBe(200);
  await app.close();
  const next = await openServer();
  const before = (await next.app.inject({ method: "GET", url: `${base}/rec-production` })).json().recording as EventRecordingFile;
  expect(assessEventRecording(before)).toMatchObject({ integrityOk: true, completeness: "gapped", totals: { eventCount: 2, gapCount: 1, outOfOrderCount: 1 } });
  const resumed = await next.app.inject({ method: "POST", url: `${base}/rec-production/resume`, payload: { connectionId: "manual-origin", generation: 1, lastSequence: 3, lastTimestamp: null, reason: "manual-reopen" } });
  expect(resumed.statusCode).toBe(201);
  const after = resumed.json().recording as EventRecordingFile;
  expect(after.segments[0]).toEqual(before.segments[0]);
  expect(after.segments[1].resume).toMatchObject({ generation: 1, lastSequence: 3 });
  expect(assessEventRecording(after).totals.seamCount).toBe(1);
  const live = await next.app.inject({ method: "POST", url: `/api/projects/${project.id}/data/events`, payload: { source: "live", key: "temperature", value: 29 } });
  expect(live.statusCode).toBe(202); expect(next.bus.latest(project.id)).toHaveLength(1); expect(bus.latest(project.id)).toHaveLength(0);
});
