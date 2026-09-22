import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { loadConfig } from "../apps/api/src/config.js";
import { registerConfiguredDashboardNative } from "../apps/api/src/dashboardNativeStartup.js";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

// Reuse immutable test publication/object bytes; do not duplicate EXE/ZIP/font files.
const [priorArg, outputArg, densityArg] = process.argv.slice(2);
assert(priorArg && outputArg, "Expected <prior-upgrade-evidence> <new-output-directory>");
const prior = path.resolve(priorArg), output = path.resolve(outputArg);
await mkdir(output);
const deployment = JSON.parse(await readFile(path.join(prior, "deployment-v2.json"), "utf8"));
if (densityArg !== undefined) {
  assert(densityArg === "1" || densityArg === "2", "Expected text density 1 or 2");
  deployment.configuration.textRasterScale = Number(densityArg);
}
const database = JSON.parse(await readFile(path.join(prior, "isolated-metadata/database.json"), "utf8"));
const publication = database.publishedApplications.find((value: any) => value.applicationId === deployment.fontCatalog.applicationId);
assert(publication);
if (!deployment.fontCatalog.nodes.some((node: any) => node.nodeId === "mc-table")) deployment.fontCatalog.nodes.push({ nodeId: "mc-table", fonts: ["notocjk-400", "notocjk-700"],
  textStyle: { fontSize: 14, lineHeight: 21, fontWeight: 400, fontStyle: "normal", color: [238, 242, 244, 255], align: "left" } });
const deploymentFile = path.join(output, "deployment.json");
await writeFile(deploymentFile, JSON.stringify(deployment, null, 2));
const store = new JsonStore(path.join(prior, "isolated-metadata")); await store.init();
const objects = new LocalObjectStore(path.join(prior, "isolated-objects"));
const app = createApiServer();
app.addHook("preHandler", async request => { request.systemUser = {
  id: "measured-widget-recovery", role: "editor", enabled: true, projectIds: [publication.projectId] } as never; });
try {
  const registered = await registerConfiguredDashboardNative(app, { store, objects, config: loadConfig() }, deploymentFile);
  assert(registered);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const candidateStartedAt = Date.now();
  const response = await fetch(`${origin}/api/projects/${publication.projectId}/applications/${publication.applicationId}/dashboard-candidates`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicationId: publication.id, applicationRevision: publication.applicationRevision,
      entryPageId: publication.document.pages[0].id }), signal: AbortSignal.timeout(600_000) });
  const result = await response.json();
  const candidateElapsedMs = Date.now() - candidateStartedAt;
  assert.equal(response.status, 201, JSON.stringify(result));
  assert(result && typeof result === "object" && "candidateId" in result && typeof result.candidateId === "string");
  const record = registered.registry.read({ candidateId: result.candidateId,
    projectId: publication.projectId, applicationId: publication.applicationId });
  assert(record);
  const packageBytes = Buffer.from(record.candidate.artifact.artifact);
  const packagePath = path.join(output, "runtime-package.json");
  await writeFile(packagePath, packageBytes);
  await writeFile(path.join(output, "capability.json"), JSON.stringify(record.candidate.capability, null, 2));
  for (const nodeId of ["mc-kpi", "mc-table"]) {
    const object = record.candidate.capability.objects.find(value => value.nodeId === nodeId);
    assert(object && object.status !== "blocked", `${nodeId} must contain compiled measured content`);
    assert(object.deferredFields.includes("runtime.interactions"), `${nodeId} static capture must retain deferred interactions`);
  }
  assert.equal(record.candidate.capability.objects.find(value => value.nodeId === "mc-filter")?.status, "blocked",
    "Filter remains blocked until the dataset and presented interaction chain is implemented");
  await app.close();
  const captures = [];
  for (const label of ["round-1", "round-2"]) {
    const capture = await captureNativePlayerWindow({ label, executable: deployment.nativeExecutable,
      args: ["--package", packagePath], env: { ...process.env, DEEP_ENGINE_ATLAS_EVIDENCE: "1",
        LOCALAPPDATA: path.join(output, "local-app-data") }, outputDirectory: output,
      presentedMarker: "native package recovery checkpoint committed after present", timeoutMs: 60_000 });
    captures.push(capture);
  }
  await writeFile(path.join(output, "evidence.json"), JSON.stringify({ captures,
    candidateElapsedMs, capability: record.candidate.capability, packageBytes: packageBytes.length }, null, 2));
  console.log(JSON.stringify({ output, packageBytes: packageBytes.length, captures: captures.map(value => value.png) }));
} finally { await app.close(); }
