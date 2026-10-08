import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = resolve(process.argv[2] ?? join(root, "test-output/studio-texture-delivery-20261007/qa-uv-box.glb"));
const modelBytes = await readFile(modelPath), suffix = randomBytes(4).toString("hex");
const output = join(root, "test-output", `docker-020-qa-${suffix}`);
await mkdir(output, { recursive: true });
const password = randomBytes(24).toString("hex");
const environment = { STUDIO_VERSION: "0.2.0", STUDIO_PORT: "24100", STUDIO_PUBLIC_ORIGIN: "http://localhost:24100",
  POSTGRES_PORT: "25432", POSTGRES_PASSWORD: password, MINIO_API_PORT: "29000", MINIO_CONSOLE_PORT: "29001",
  MINIO_ROOT_USER: `studioqa${suffix}`, MINIO_ROOT_PASSWORD: password, BIM_STUDIO_ADMIN_PASSWORD: password,
  BIM_STUDIO_SESSION_SECRET: randomBytes(32).toString("hex"), BIM_STUDIO_MINIO_IMAGE: "deep-monkey-minio:2025.5.24",
  BIM_STUDIO_POSTGRES_VOLUME: `studio_qa_pg_${suffix}`, BIM_STUDIO_MINIO_VOLUME: `studio_qa_minio_${suffix}`,
  BIM_STUDIO_DATA_VOLUME: `studio_qa_data_${suffix}` };
const envFile = join(output, ".env");
await writeFile(envFile, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
const overlay = join(output, "compose.qa.json");
await writeFile(overlay, JSON.stringify({ services: { postgres: { container_name: `studio-qa-postgres-${suffix}` },
  minio: { container_name: `studio-qa-minio-${suffix}` } } }, null, 2));
const composeArgs = ["compose", "--project-name", `studio-qa-${suffix}`, "--env-file", envFile,
  "-f", "docker-compose.yml", "-f", "docker-compose.app.yml", "-f", overlay];
const report = { schemaVersion: 1, status: "running", output, version: "0.2.0", startedAt: new Date().toISOString(),
  scopes: ["production-web", "postgres", "minio", "save-publication", "restart-without-pull"], steps: [] };
async function compose(args) {
  let log = "";
  const child = spawn("docker", [...composeArgs, ...args], { cwd: root, windowsHide: true,
    env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { log += bytes; }); child.stderr.on("data", bytes => { log += bytes; });
  const code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); });
  await writeFile(join(output, `compose-${args[0]}.log`), log);
  assert.equal(code, 0, `compose ${args[0]} failed; see ${output}`);
}
const origin = "http://127.0.0.1:24100";
let token;
async function api(path, options = {}) {
  const response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(10_000), headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
    ...options.headers } });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}
async function login() {
  const result = await (await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password }) })).json();
  assert.equal(result.user.role, "admin"); token = result.token;
}
function step(name, evidence = {}) { report.steps.push({ name, ...evidence }); console.log(`[docker-qa] ${name}`); }
try {
  await compose(["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"]);
  const html = await (await api("/")).text(); assert.match(html, /<html/i);
  const entryAssets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map(match => match[1]);
  assert.ok(entryAssets.some(asset => asset.endsWith(".js")), "production HTML must reference its JS entry");
  for (const asset of new Set(entryAssets)) {
    const response = await api(asset);
    assert.match(response.headers.get("content-type") ?? "", asset.endsWith(".js") ? /javascript/ : /css/);
    const served = Buffer.from(await response.arrayBuffer()), expected = await readFile(join(root, "apps/web/dist", asset));
    assert.equal(createHash("sha256").update(served).digest("hex"), createHash("sha256").update(expected).digest("hex"), asset);
  }
  step("production JS and CSS entry bytes", { entryAssets });
  const wasm = Buffer.from(await (await api("/engine-wasm/deep_engine_wasm_bg.wasm")).arrayBuffer());
  const expectedWasm = await readFile(join(root, "apps/web/public/engine-wasm/deep_engine_wasm_bg.wasm"));
  assert.equal(createHash("sha256").update(wasm).digest("hex"), createHash("sha256").update(expectedWasm).digest("hex"));
  step("production Web and matching WASM");
  await login(); step("production admin login");
  const project = await (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `Docker QA ${suffix}` }) })).json();
  const form = new FormData(); form.append("file", new Blob([modelBytes], { type: "model/gltf-binary" }), "qa-uv-box.glb");
  const uploaded = await (await api(`/api/projects/${project.id}/models`, { method: "POST", body: form })).json();
  let ready;
  for (let index = 0; index < 60; index++) {
    const current = await (await api(`/api/projects/${project.id}`)).json();
    ready = current.models.find(model => model.id === uploaded.id);
    if (ready?.status === "ready") break;
    assert.notEqual(ready?.status, "failed", ready?.message);
    await new Promise(done => setTimeout(done, 1000));
  }
  assert.equal(ready?.status, "ready");
  const sourceHash = createHash("sha256").update(modelBytes).digest("hex");
  const source = Buffer.from(await (await api(ready.sourceUrl)).arrayBuffer());
  assert.equal(createHash("sha256").update(source).digest("hex"), sourceHash);
  step("GLB upload, conversion, MinIO readback", { modelId: uploaded.id, sourceHash });
  const sceneId = randomUUID(), scenePath = `/api/projects/${project.id}/scenes/${sceneId}`;
  const now = new Date().toISOString(), fixture = JSON.parse(await readFile(join(root, "test-fixtures/scene-v1-pure-3d.json"), "utf8"));
  const scene = { ...fixture, id: sceneId, projectId: project.id, name: `Docker scene ${suffix}`, createdAt: now, updatedAt: now };
  await api(scenePath, { method: "PUT", body: JSON.stringify(scene) });
  const publication = await (await api(`${scenePath}/publish`, { method: "POST" })).json();
  assert.equal(publication.sceneId, sceneId); step("scene save and publication", { projectId: project.id, sceneId });
  await compose(["down"]);
  token = undefined;
  await compose(["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"]);
  await login();
  const recovered = await (await api(scenePath)).json(); assert.equal(recovered.name, scene.name);
  const history = await (await api(`${scenePath}/publications`)).json(); assert.ok(history.length > 0);
  const recoveredSource = Buffer.from(await (await api(ready.sourceUrl)).arrayBuffer());
  assert.equal(createHash("sha256").update(recoveredSource).digest("hex"), sourceHash);
  step("all containers recreated without image pulls; PostgreSQL, MinIO and scene recovered");
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  await compose(["down"]).catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
  report.finishedAt = new Date().toISOString(); await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
