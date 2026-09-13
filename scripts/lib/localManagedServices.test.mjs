import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureManagedService, localManagedServices, probeManagedService } from "./localManagedServices.mjs";

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("probes service identity and readiness, not merely an open HTTP port", async t => {
  let body = {};
  let status = 200;
  const healthUrl = await fixture(t, (_req, res) => { res.writeHead(status); res.end(JSON.stringify(body)); });
  for (const [id, healthy] of [
    ["media", { itemCount: 0, items: [] }],
    ["battery-native", { status: "ready", runtime: "rust-ort", model: "battery.spm-pino" }],
    ["cloud-render-worker", { contractVersion: 1, workerId: "worker", status: "ready" }],
  ]) {
    body = { status: "ok" };
    assert.equal(await probeManagedService({ id, healthUrl }), false);
    body = healthy;
    assert.equal(await probeManagedService({ id, healthUrl }), true);
    status = 503;
    assert.equal(await probeManagedService({ id, healthUrl }), false);
    status = 200;
  }
  body = { contractVersion: 1, workerId: "worker", status: "degraded" };
  assert.equal(await probeManagedService({ id: "cloud-render-worker", healthUrl }), false);
});

test("reuses healthy external instances and refuses wrong services or remote spawning", async t => {
  let ready = true;
  const healthUrl = await fixture(t, (_req, res) => { res.end(JSON.stringify(ready ? { itemCount: 0, items: [] } : {})); });
  const service = { id: "media", label: "实时视频", host: "127.0.0.1", port: Number(new URL(healthUrl).port), healthUrl };
  const neverStart = () => assert.fail("must not spawn");
  assert.equal(await ensureManagedService(service, { canConnect: async () => true, start: neverStart }), "external");
  ready = false;
  await assert.rejects(ensureManagedService(service, { canConnect: async () => true, start: neverStart }), /已占用/);
  await assert.rejects(ensureManagedService({ ...service, host: "remote.test" }, { canConnect: async () => false, start: neverStart }), /远程服务/);
  assert.equal(await ensureManagedService(service, { canConnect: async () => false, start: () => { ready = true; } }), "managed");
  ready = false;
  await assert.rejects(ensureManagedService(service, { canConnect: async () => false, start: () => {}, timeoutMs: 0 }), /media.err.log/);
});

test("starts current source headlessly and reuses the private token across restarts", async t => {
  const root = await mkdtemp(join(tmpdir(), "studio-services-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {};
  const services = localManagedServices(root, environment, { apiOrigin: "http://127.0.0.1:4100", webOrigin: "http://127.0.0.1:5173" });
  assert.deepEqual(services.map(item => item.id), ["battery-native", "media", "cloud-render-worker"]);
  assert.equal(services[2].environment.CLOUD_RENDER_HEADLESS, "true");
  assert.equal(services[2].args.at(-1), "dev");
  assert.equal(environment.BATTERY_MODEL_SERVICE_URL, "http://127.0.0.1:8030");
  assert.equal(environment.CLOUD_RENDER_PUBLIC_ORIGIN, "http://127.0.0.1:5173");
  assert.equal(services[2].environment.CLOUD_RENDER_WORKER_PUBLIC_ORIGIN, "http://127.0.0.1:4100");
  const saved = JSON.parse(await readFile(join(root, "data/cloud-render-worker.json"), "utf8"));
  assert.equal(environment.CLOUD_RENDER_WORKER_TOKEN, saved.token);
  const restartedEnvironment = {};
  localManagedServices(root, restartedEnvironment, { apiOrigin: "http://127.0.0.1:4100" });
  assert.equal(restartedEnvironment.CLOUD_RENDER_WORKER_TOKEN, saved.token);
  assert.equal(localManagedServices(root, {}, { apiOrigin: "http://127.0.0.1:4100", cloudWorker: false }).length, 2);
  assert.throws(() => localManagedServices(root, { CLOUD_RENDER_WORKER_PORT: "4100" }, { apiOrigin: "http://127.0.0.1:4100" }), /同一个端口/);
  assert.throws(() => localManagedServices(root, { CLOUD_RENDER_WORKER_PORT: "oops" }, { apiOrigin: "http://127.0.0.1:4100" }), /端口无效/);
});
