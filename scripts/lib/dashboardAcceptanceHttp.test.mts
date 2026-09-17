import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../apps/api/src/serverOptions.js";
import { JsonStore } from "../../apps/api/src/jsonStore.js";
import { dashboardAcceptanceHttp, publishDashboardAcceptanceFixture } from "./dashboardAcceptanceHttp.mts";

test("uses actual local HTTP with binary responses and rejects external destinations", async () => {
  const app = createApiServer();
  app.get("/api/binary", async (_request, reply) => reply.type("application/octet-stream").send(Buffer.from([0, 255, 1])));
  try {
    const request = await dashboardAcceptanceHttp(app);
    const bytes = await request({ method: "GET", url: "/api/binary" });
    assert.equal(bytes.statusCode, 200); assert.deepEqual(bytes.rawPayload, Buffer.from([0, 255, 1]));
    assert.equal((await request({ method: "GET", url: "/api/missing" })).statusCode, 404);
    await assert.rejects(request({ method: "GET", url: "http://example.invalid/api/data" }), /local API/);
    await assert.rejects(request({ method: "GET", url: "//example.invalid/api/data" }), /local API/);
  } finally { await app.close(); }
});

test("creates, edits, publishes and publicly reads a disk-backed document through HTTP", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-http-acceptance-"));
  try {
    const store = new JsonStore(directory); await store.init();
    const project = await store.createProject("HTTP test", "isolated");
    const source = JSON.parse(await readFile(new URL("../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url), "utf8"));
    source.application.metadata.projectId = project.id;
    source.application.metadata.name = "Edited through HTTP";
    const published = await publishDashboardAcceptanceFixture(store, project.id, source.application);
    assert.equal(published.document.metadata.name, "Edited through HTTP");
    assert.equal(published.applicationRevision, 2);
    const reopened = new JsonStore(directory); await reopened.init();
    assert.deepEqual(reopened.getPublishedApplication(published.id), published);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
