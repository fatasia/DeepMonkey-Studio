import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversionTaskRecord, ConverterPluginManifest, ModelRecord } from "@bim-studio/contracts";
import { createIsolatedPostgres, postgresFixtureTools } from "../scripts/isolatedPostgresFixture.mjs";
import { PostgresStore } from "./postgresStore.js";
import { defaultDocument } from "./storeUtils.js";
import { ConversionTaskService } from "./conversionTasks.js";

const tools = postgresFixtureTools();
let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
const model = (id: string): ModelRecord => ({ id, projectId: "default", name: id, format: "obj", size: 1, sourceUrl: `/assets/${id}.obj`, status: "queued", progress: 0, createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z" });
let sequence = 0;
async function openStore() {
  const store = new PostgresStore(path.join(fixture.output, `metadata-${sequence++}`), {
    ...fixture.connection, psqlPath: path.join(path.dirname(tools!.pg_ctl), process.platform === "win32" ? "psql.exe" : "psql"),
  });
  await store.init();
  return store;
}

describe.skipIf(!tools)("metadata CAS on real isolated PostgreSQL", () => {
  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.client.query("CREATE TABLE bim_studio_state (id SMALLINT PRIMARY KEY CHECK(id=1), document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await fixture.client.query("INSERT INTO bim_studio_state(id,document) VALUES(1,$1)", [defaultDocument()]);
  }, 60000);
  afterAll(async () => { await fixture?.close(); }, 30000);

  it("migrates the existing row, rejects a stale writer, and retries from refreshed state", async () => {
    const first = await openStore(), second = await openStore();
    await first.addModel("default", model("first"));
    await expect(second.addModel("default", model("second"))).rejects.toMatchObject({ statusCode: 409, code: "metadata_revision_conflict" });
    expect(second.getProject("default")!.models.map(item => item.id)).toEqual(["first"]);
    await second.addModel("default", model("second"));
    const reopened = await openStore();
    expect(reopened.getProject("default")!.models.map(item => item.id)).toEqual(["first", "second"]);
  });

  it("accepts exactly one concurrent same-version write without losing the previous models", async () => {
    const first = await openStore(), second = await openStore();
    const writes = await Promise.allSettled([first.addModel("default", model("race-a")), second.addModel("default", model("race-b"))]);
    expect(writes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(writes.find(item => item.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
    const reopened = await openStore();
    const ids = reopened.getProject("default")!.models.map(item => item.id);
    expect(ids).toContain("first"); expect(ids).toContain("second");
    expect(ids.filter(id => id.startsWith("race-"))).toHaveLength(1);
  });

  it("retains SQL-looking strings as JSON data and remains writable after a conflict", async () => {
    const store = await openStore();
    const value = { ...model("quoted"), name: "x'); DROP TABLE bim_studio_state; --" };
    await store.addModel("default", value);
    const reopened = await openStore();
    expect(reopened.getProject("default")!.models.find(item => item.id === "quoted")).toEqual(value);
    expect((await fixture.client.query("SELECT revision FROM bim_studio_state WHERE id=1")).rows[0].revision).toMatch(/^\d+$/);
  });

  it("rejects a stale conversion publication without replacing the winning ready pointer", async () => {
    const first = await openStore();
    await first.addModel("default", { ...model("converted"), status: "ready", manifestUrl: "/assets/old.json" });
    const running: ConversionTaskRecord = { id: "attempt-cas", projectId: "default", modelId: "converted", pluginId: "test.cas", pluginVersion: "1",
      input: { fileName: "converted.obj", format: "obj", objectKey: "source/converted.obj", size: 1 }, configuration: {}, status: "running",
      progress: 1, message: "running", artifacts: [], createdAt: "now", updatedAt: "now" };
    await first.saveConversionTask(running);
    const second = await openStore();
    const completed = { ...running, status: "succeeded" as const, progress: 100, finishedAt: "done" };
    await first.saveConversionTask(completed, { status: "ready", manifestUrl: "/assets/winner.json" });
    await expect(second.saveConversionTask(completed, { status: "ready", manifestUrl: "/assets/stale.json" })).rejects.toMatchObject({ statusCode: 409 });
    expect(second.getProject("default")!.models.find(item => item.id === "converted")?.manifestUrl).toBe("/assets/winner.json");
    await expect(second.saveConversionTask(completed, { status: "ready", manifestUrl: "/assets/stale.json" })).rejects.toThrow("终态");
    const reopened = await openStore();
    expect(reopened.getProject("default")!.models.find(item => item.id === "converted")?.manifestUrl).toBe("/assets/winner.json");
  });

  it("does not advance its revision or expose a candidate after database rejection", async () => {
    const store = await openStore();
    const before = (await fixture.client.query("SELECT revision FROM bim_studio_state WHERE id=1")).rows[0].revision;
    await fixture.client.query("ALTER TABLE bim_studio_state ADD CONSTRAINT test_reject CHECK(document::text NOT LIKE '%db-reject%')");
    await expect(store.addModel("default", model("db-reject"))).rejects.toThrow();
    expect(store.getProject("default")!.models.some(item => item.id === "db-reject")).toBe(false);
    expect((await fixture.client.query("SELECT revision FROM bim_studio_state WHERE id=1")).rows[0].revision).toBe(before);
    await store.addModel("default", model("after-reject"));
    await fixture.client.query("ALTER TABLE bim_studio_state DROP CONSTRAINT test_reject");
  });

  it("fences expired owners and unleased callbacks after a real lease takeover", async () => {
    const first = await openStore();
    await first.addModel("default", { ...model("leased-model"), status: "ready", manifestUrl: "/assets/kept.json" });
    const task: ConversionTaskRecord = { id: "leased-task", projectId: "default", modelId: "leased-model", pluginId: "test.lease", pluginVersion: "1",
      input: { fileName: "input.obj", format: "obj", objectKey: "source/input.obj", size: 1 }, configuration: {}, status: "running",
      progress: 1, message: "running", artifacts: [], createdAt: "now", updatedAt: "now" };
    const oldLease = (await first.acquireConversionTaskLease(task.id, "worker-a"))!;
    expect(oldLease.epoch).toBe("1");
    await first.saveConversionTask(task, undefined, oldLease);
    const second = await openStore();
    expect(await second.acquireConversionTaskLease(task.id, "worker-b")).toBeUndefined();
    expect(await first.renewConversionTaskLease(oldLease)).toMatchObject({ epoch: "1", ownerId: "worker-a" });
    await expect(second.saveConversionTask({ ...task, status: "failed" })).rejects.toMatchObject({ statusCode: 409 });
    await fixture.client.query("UPDATE bim_studio_conversion_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1", [task.id]);
    const nextLease = (await second.acquireConversionTaskLease(task.id, "worker-b"))!;
    expect(nextLease.epoch).toBe("2");
    expect(await first.renewConversionTaskLease(oldLease)).toBeUndefined();
    await first.releaseConversionTaskLease(oldLease);
    expect(await second.activeConversionTaskLease(task.id)).toBe(true);
    const done = { ...task, status: "succeeded" as const, progress: 100, finishedAt: "done" };
    await expect(first.saveConversionTask(done, { status: "ready", manifestUrl: "/assets/stale-owner.json" }, oldLease)).rejects.toMatchObject({ statusCode: 409 });
    await expect(first.saveConversionTask(done, { status: "ready", manifestUrl: "/assets/no-owner.json" })).rejects.toMatchObject({ statusCode: 409 });
    expect(first.getProject("default")!.models.find(item => item.id === task.modelId)?.manifestUrl).toBe("/assets/kept.json");
    await second.saveConversionTask(done, { status: "ready", manifestUrl: "/assets/lease-winner.json" }, nextLease);
    await second.releaseConversionTaskLease(nextLease);
    expect(await second.activeConversionTaskLease(task.id)).toBe(false);
    expect((await openStore()).getProject("default")!.models.find(item => item.id === task.modelId)?.manifestUrl).toBe("/assets/lease-winner.json");
  });

  it("grants only one owner when two stores claim an absent lease concurrently", async () => {
    const first = await openStore(), second = await openStore();
    const leases = await Promise.all([first.acquireConversionTaskLease("lease-race", "worker-a"), second.acquireConversionTaskLease("lease-race", "worker-b")]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const lease = leases.find(Boolean)!;
    await first.releaseConversionTaskLease(lease);
    expect(await second.acquireConversionTaskLease("lease-race", "worker-next")).toMatchObject({ epoch: "2" });
  });

  it("rechecks the lease owner after a concurrent takeover releases its row lock", async () => {
    const store = await openStore();
    const lease = (await store.acquireConversionTaskLease("lease-lock-race", "old-worker"))!;
    const task: ConversionTaskRecord = { id: lease.taskId, projectId: "default", pluginId: "test.lock", pluginVersion: "1",
      input: { fileName: "input.obj", format: "obj", objectKey: "source/input.obj", size: 1 }, configuration: {}, status: "running",
      progress: 1, message: "running", artifacts: [], createdAt: "now", updatedAt: "now" };
    await store.saveConversionTask(task, undefined, lease);
    await fixture.client.query("BEGIN");
    await fixture.client.query("SELECT task_id FROM bim_studio_conversion_leases WHERE task_id=$1 FOR UPDATE", [task.id]);
    const pending = store.saveConversionTask({ ...task, status: "succeeded", progress: 100 }, undefined, lease)
      .then(() => "accepted", error => error.statusCode);
    try {
      await vi.waitFor(async () => {
        await fixture.client.query("SELECT pg_stat_clear_snapshot()");
        const activity = await fixture.client.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%UPDATE bim_studio_state%'");
        expect(Number(activity.rows[0].count)).toBeGreaterThan(0);
      }, { timeout: 2000 });
      await fixture.client.query("UPDATE bim_studio_conversion_leases SET owner_id='new-worker',epoch=epoch+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE task_id=$1", [task.id]);
      await fixture.client.query("COMMIT");
      expect(await pending).toBe(409);
      expect(store.listConversionTasks().find(row => row.id === task.id)?.status).toBe("running");
    } finally { await fixture.client.query("ROLLBACK");await pending; }
  });

  it("preserves a live service on restart and fences its output after expired-attempt recovery", async () => {
    const firstStore = await openStore();
    await firstStore.addModel("default", { ...model("service-lease-model"), status: "ready", manifestUrl: "/assets/previous-ready.json" });
    const manifest: ConverterPluginManifest = { contractVersion: 1, id: "test.service-lease", name: "lease", version: "1", execution: "server-worker",
      inputFormats: ["obj"], outputs: [{ kind: "geometry", format: "glb", required: true }], configurationSchema: { type: "object" }, capabilities: [],
      limits: { timeoutMs: 30000, maxInputBytes: 100, maxOutputBytes: 100, maxMemoryMb: 256, maxCpuPercent: 100 } };
    let finish: (() => void) | undefined;
    const first = new ConversionTaskService([{ manifest, execute: async context => {
      await new Promise<void>(resolve => { finish = resolve; });
      context.publishArtifact({ kind: "geometry", format: "glb", objectKey: `${context.outputPrefix}geometry.glb`, size: 1 });
      context.stageModelUpdate({ status: "ready", manifestUrl: "/assets/stale-service.json" });
    } }], undefined, () => "service-lease-task", firstStore);
    await first.submitDurable({ projectId: "default", modelId: "service-lease-model", pluginId: manifest.id,
      input: { fileName: "input.obj", format: "obj", objectKey: "projects/default/source/input.obj", size: 1 } });
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const otherStore = await openStore();
      const other = new ConversionTaskService([{ manifest }], undefined, undefined, otherStore);
      await other.initialize();expect(other.get("default", "service-lease-task")?.status).toBe("running");
      await fixture.client.query("UPDATE bim_studio_conversion_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id='service-lease-task'");
      await other.refresh();expect(other.get("default", "service-lease-task")?.status).toBe("failed");
      finish!();
      await vi.waitFor(() => expect(first.get("default", "service-lease-task")?.status).toBe("failed"));
      const persisted = await openStore();
      expect(persisted.getProject("default")!.models.find(row => row.id === "service-lease-model")?.manifestUrl).toBe("/assets/previous-ready.json");
      expect(persisted.listConversionTasks().find(row => row.id === "service-lease-task")?.artifacts).toEqual([]);
    } finally { finish?.(); }
  }, 15000);

  it("converges when two instances initialize an empty state table", async () => {
    await fixture.client.query("DELETE FROM bim_studio_state WHERE id=1");
    const [first, second] = await Promise.all([openStore(), openStore()]);
    expect(first.listProjects()).toEqual(second.listProjects());
    expect((await fixture.client.query("SELECT count(*) FROM bim_studio_state")).rows[0].count).toBe("1");
  });

  it("persists remote cancel intent, fences completion, and retains it across lease takeover", async () => {
    const first=await openStore(), lease=(await first.acquireConversionTaskLease("cancel-intent", "owner-a"))!;
    const task: ConversionTaskRecord={id:lease.taskId,projectId:"default",pluginId:"test.cancel",pluginVersion:"1",
      input:{fileName:"input.obj",format:"obj",objectKey:"source/input.obj",size:1},configuration:{},status:"running",
      progress:1,message:"running",artifacts:[],createdAt:"now",updatedAt:"now"};
    await first.saveConversionTask(task,undefined,lease);
    const second=await openStore();
    expect(await second.requestConversionCancellation(task.id)).toBe(true);
    expect(await second.requestConversionCancellation(task.id)).toBe(true);
    expect((await second.refreshConversionTasks()).find(row=>row.id===task.id)?.status).toBe("cancelling");
    expect(await first.renewConversionTaskLease(lease)).toMatchObject({cancelRequested:true});
    await expect(first.saveConversionTask({...task,status:"succeeded",progress:100},undefined,lease)).rejects.toMatchObject({statusCode:409});
    await fixture.client.query("UPDATE bim_studio_conversion_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",[task.id]);
    const recovered=new ConversionTaskService([],undefined,undefined,second);await recovered.initialize();
    expect(recovered.get("default",task.id)?.status).toBe("cancelled");
    expect((await openStore()).listConversionTasks().find(row=>row.id===task.id)?.artifacts).toEqual([]);
    expect(await second.requestConversionCancellation(task.id)).toBe(false);
  });
});
