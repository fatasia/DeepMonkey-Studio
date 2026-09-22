import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { loadConfig } from "../apps/api/src/config.js";
import { registerConfiguredDashboardNative } from "../apps/api/src/dashboardNativeStartup.js";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const [priorArg, outputArg, profile] = process.argv.slice(2);
assert(profile === undefined || profile === "--linked-table-fixture", "Unknown filter fixture profile");
assert(priorArg && outputArg, "Expected prior evidence and new output directory");
const prior = path.resolve(priorArg), output = path.resolve(outputArg);
await mkdir(output);
const deployment = JSON.parse(await readFile(path.join(prior, "deployment-v2.json"), "utf8"));
const frozenExecutable = path.join(output, "deep-engine-native.exe");
await copyFile(process.env.DEEP_FILTER_EXECUTABLE ?? deployment.nativeExecutable, frozenExecutable);
deployment.nativeExecutable = frozenExecutable;
const database = JSON.parse(await readFile(path.join(prior, "isolated-metadata/database.json"), "utf8"));
const publication = database.publishedApplications.find((item: any) => item.applicationId === deployment.fontCatalog.applicationId);
assert(publication);
const filter = publication.document.pages.flatMap((page: any) => page.nodes).find((node: any) => node.id === "mc-filter");
assert.deepEqual(filter.widget.options, ["全部区域", "华东", "华北", "华南"]);
// Isolated author correction, not a new Native matching rule or a mutation of the prior publication.
filter.widget.options[0] = "全部";
if (profile === "--linked-table-fixture") {
  const table = publication.document.pages.flatMap((page: any) => page.nodes).find((node: any) => node.id === "mc-table");
  assert.equal(table.widget.sampleData.rows.length, 4);
  table.widget.sampleData.rows.forEach((row: any, index: number) => { row.region = ["华东", "华北", "华东", "华南"][index]; });
  if (process.env.DEEP_TABLE_PAGE_SIZE) table.widget.report = { ...table.widget.report, pageSize: Number(process.env.DEEP_TABLE_PAGE_SIZE) };
}
deployment.fontCatalog.nodes.push({ nodeId: "mc-filter", fonts: ["notocjk-400"],
  textStyle: { fontSize: 16, lineHeight: 24, fontWeight: 400, fontStyle: "normal", color: [238, 242, 244, 255], align: "left" } });
if (!deployment.fontCatalog.nodes.some((node: any) => node.nodeId === "mc-table"))
  deployment.fontCatalog.nodes.push({ nodeId: "mc-table", fonts: ["notocjk-400", "notocjk-700"],
    textStyle: { fontSize: 14, lineHeight: 21, fontWeight: 400, fontStyle: "normal", color: [238, 242, 244, 255], align: "left" } });
deployment.configuration.textRasterScale = 2;
await mkdir(path.join(output, "metadata"));
await writeFile(path.join(output, "metadata/database.json"), JSON.stringify(database));
const deploymentFile = path.join(output, "deployment.json");
await writeFile(deploymentFile, JSON.stringify(deployment, null, 2));
const store = new JsonStore(path.join(output, "metadata")); await store.init();
const objects = new LocalObjectStore(path.join(prior, "isolated-objects"));
const app = createApiServer();
app.addHook("preHandler", async request => { request.systemUser = {
  id: "filter-production-verification", role: "editor", enabled: true, projectIds: [publication.projectId] } as never; });
let packagePath: string;
try {
  const registered = await registerConfiguredDashboardNative(app, { store, objects, config: loadConfig() }, deploymentFile);
  assert(registered);
  const prepare = registered.runtime.service.prepare.bind(registered.runtime.service);
  registered.runtime.service.prepare = async (...args) => {
    try { return await prepare(...args); }
    catch (error) { console.error("Filter production candidate failed", error); throw error; }
  };
  const compileStarted = performance.now();
  const response = await app.inject({ method: "POST",
    url: `/api/projects/${publication.projectId}/applications/${publication.applicationId}/dashboard-candidates`,
    payload: { publicationId: publication.id, applicationRevision: publication.applicationRevision,
      entryPageId: publication.document.pages[0].id } });
  assert.equal(response.statusCode, 201, response.body);
  await writeFile(path.join(output, "compile-timing.json"), JSON.stringify({ candidateMs: performance.now() - compileStarted,
    statusCode: response.statusCode, nativeExecutable: frozenExecutable }, null, 2));
  const record = registered.registry.read({ candidateId: response.json().candidateId,
    projectId: publication.projectId, applicationId: publication.applicationId });
  assert(record);
  packagePath = path.join(output, "runtime-package.json");
  await writeFile(packagePath, record.candidate.artifact.artifact);
  await writeFile(path.join(output, "capability.json"), JSON.stringify(record.candidate.capability, null, 2));
  const envelope = JSON.parse(Buffer.from(record.candidate.artifact.artifact).toString("utf8"));
  const runtime = envelope.payloads[envelope.entrypoints.dashboard];
  assert.equal(runtime.filter.options.length, 4);
  assert.deepEqual(runtime.filter.options.map((option: any) => option.updates[0].datasets[0].rows.length), [3, 1, 1, 1]);
} finally { await app.close(); }
const captures = [];
for (const round of [1, 2]) for (const option of [0, 1, 2, 3]) {
  const capture = await captureNativePlayerWindow({ label: `round-${round}-option-${option}`,
    executable: deployment.nativeExecutable, args: ["--package", packagePath!], outputDirectory: output,
    clientSize: [960, 540], clientClick: [60, 292 + option * 63],
    env: { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data"), DEEP_DASHBOARD_FILTER_EVIDENCE: "1" },
    presentedMarker: "native Deep2d", timeoutMs: 60_000 });
  if (option !== 0) assert(capture.playerLogTail?.includes(`selected=Some(${option})`), capture.playerLogTail);
  captures.push(capture);
}
await writeFile(path.join(output, "evidence.json"), JSON.stringify({
  source: prior, authorCorrection: { nodeId: "mc-filter", before: "全部区域", after: "全部", reason: "existing Web clear sentinel" },
  scope: "single select frozen sample chart and measured data variants", profile: profile ?? "original-table-without-region", captures,
}, null, 2));
console.log(`Filter production windows passed: ${captures.length}`);
