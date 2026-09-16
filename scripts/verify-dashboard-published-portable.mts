import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { loadConfig } from "../apps/api/src/config.js";
import { registerConfiguredDashboardNative } from "../apps/api/src/dashboardNativeStartup.js";
import { parseDashboardOfflineArchive } from "../apps/api/src/dashboardOfflineArchiveBytes.js";
import { assertDashboardDocument } from "../packages/contracts/src/index.ts";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const JSZip = require("jszip");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const usage = "pnpm exec tsx --conditions=development scripts/verify-dashboard-published-portable.mts <native.exe> <device-sha256> <new-output-directory> [--sample-chart]";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [executable, deviceFingerprint, output, variant] = args;
  if ((args.length !== 3 && !(args.length === 4 && variant === "--sample-chart"))
    || !executable || !deviceFingerprint || !output || !/^[a-f0-9]{64}$/.test(deviceFingerprint)) throw new Error(usage);
  const sampleChart = variant === "--sample-chart";
  const directory = path.resolve(output);
  await mkdir(directory); // Existing evidence is never overwritten.
  const nativeExecutable = path.resolve(executable);
  const deploymentFile = path.join(directory, "deployment.json");
  await writeFile(deploymentFile, JSON.stringify({ nativeExecutable, expectedDeviceFingerprintSha256: deviceFingerprint,
    configuration: { locale: "zh-CN", packageVersion: "1.0.0" } }, null, 2));

  // 独立真实磁盘 store，不连接或修改用户数据库；编译器/窗口验证器不替换。
  const metadataDirectory = path.join(directory, "isolated-metadata");
  const initialStore = new JsonStore(metadataDirectory); await initialStore.init();
  const project = await initialStore.createProject("Dashboard portable acceptance fixture", "Isolated test data, not a user project");
  const document: unknown = JSON.parse(await readFile(new URL("../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url), "utf8"));
  assertDashboardDocument(document);
  document.application.metadata.id = randomUUID();
  document.application.metadata.projectId = project.id;
  document.application.metadata.name = sampleChart ? "Portable acceptance authored bar" : "Portable acceptance shapes";
  document.application.scripts = []; document.application.interactions = []; document.application.scenes = [];
  const page = document.application.pages[0]!;
  page.width = 960; page.height = 540;
  page.nodes = [
    { id: "portable-blue-rectangle", kind: "data-widget", zIndex: 0, frame: { x: 60, y: 80, width: 360, height: 280 },
      widget: { title: "", key: "shape-a", unit: "", type: "shape", shape: "rectangle", color: "#368bd6", borderWidth: 0 } },
    { id: "portable-green-ellipse", kind: "data-widget", zIndex: 1, frame: { x: 480, y: 100, width: 320, height: 260 },
      widget: { title: "", key: "shape-b", unit: "", type: "shape", shape: "ellipse", color: "#3dbd8c", borderWidth: 0 } },
  ];
  if (sampleChart) {
    document.application.pages = [page];
    page.nodes = [{ id: "portable-author-bar", kind: "data-widget", zIndex: 0,
      frame: { x: 40, y: 40, width: 880, height: 460 },
      widget: { title: "Authored output", key: "author.value", unit: "", type: "bar", field: "value",
        analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" },
        sampleData: { sourceId: "acceptance-author-samples", rows: [{ region: "A", value: 37 }, { region: "B", value: 91 }] } } }];
  }
  assertDashboardDocument(document);
  const draft = await initialStore.createApplicationDraft(project.id, document.application, new Date().toISOString());
  assert.equal(draft.status, "created");
  const publicationId = randomUUID();
  const published = await initialStore.publishApplication(project.id, document.application.metadata.id, publicationId, new Date().toISOString());
  assert.equal(published.status, "published");
  // 重开文件存储，从落盘的 publication/pointer 读取，不依赖内存草稿。
  const store = new JsonStore(metadataDirectory); await store.init();
  const persisted = store.getPublishedApplication(publicationId); assert(persisted);
  await writeFile(path.join(directory, "published-test-fixture.json"), JSON.stringify(persisted, null, 2));
  const objects = new LocalObjectStore(path.join(directory, "isolated-objects"));
  const app = createApiServer();
  // Fixture identity exercises route project authority; authentication login is outside this gate.
  app.addHook("preHandler", async request => { request.systemUser = {
    id: "portable-fixture-editor", role: "editor", enabled: true, projectIds: [project.id],
  } as never; });
  try {
    const registered = await registerConfiguredDashboardNative(app, { store, objects, config: loadConfig() }, deploymentFile);
    assert(registered);
    const base = `/api/projects/${project.id}/applications/${persisted.applicationId}/dashboard-candidates`;
    const response = await app.inject({ method: "POST", url: base, payload: {
      publicationId, applicationRevision: persisted.applicationRevision, entryPageId: document.entryPageId,
    } });
    await writeFile(path.join(directory, "prepare-response.json"), response.body);
    assert.equal(response.statusCode, 201, response.body);
    const candidate = response.json();
    const record = registered.registry.read({ candidateId: candidate.candidateId, projectId: project.id, applicationId: persisted.applicationId });
    if (sampleChart) {
      assert.equal(record.candidate.freezeManifest.data.length, 1);
      assert.equal(record.candidate.freezeManifest.data[0]!.nodeId, "portable-author-bar");
      const runtime = JSON.parse(new TextDecoder().decode(record.candidate.artifact.artifact));
      const charts = Object.values(runtime.payloads).filter((value: any) => value.schema === "deep-engine.chart-runtime") as any[];
      assert.equal(charts.length, 1, "Published authored rows must produce a chart payload");
      assert.deepEqual(charts[0].chart.datasets[0].rows, [["A", 37], ["B", 91]]);
      assert.deepEqual(record.candidate.windowVerification.renderedNodeIds, ["portable-author-bar"]);
      assert.deepEqual(record.candidate.capability.objects.map(object => ({ nodeId: object.nodeId, status: object.status })),
        [{ nodeId: "portable-author-bar", status: "degraded" }]);
    }
    await writeFile(path.join(directory, "runtime-package.json"), record.candidate.artifact.artifact);
    await writeFile(path.join(directory, "prepared-evidence.json"), JSON.stringify({ freezeManifest: record.candidate.freezeManifest,
      capability: record.candidate.capability, windowVerification: record.candidate.windowVerification }, null, 2));
    const zipResponse = await app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` });
    assert.equal(zipResponse.statusCode, 200, zipResponse.body);
    assert.equal(zipResponse.headers["content-type"], "application/zip");
    await writeFile(path.join(directory, "dashboard.zip"), zipResponse.rawPayload);
    const archiveResponse = await app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/offline-archive` });
    assert.equal(archiveResponse.statusCode, 200, archiveResponse.body);
    await writeFile(path.join(directory, "dashboard.dmda"), archiveResponse.rawPayload);
    const verified = parseDashboardOfflineArchive(archiveResponse.rawPayload);
    const exeResponse = await app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/standalone-executable` });
    assert.equal(exeResponse.statusCode, 200, exeResponse.body);
    assert.equal(exeResponse.headers["content-type"], "application/vnd.microsoft.portable-executable");
    const standaloneDirectory = path.join(directory, "standalone"); await mkdir(standaloneDirectory);
    await writeFile(path.join(standaloneDirectory, "Dashboard.exe"), exeResponse.rawPayload);
    const footer = exeResponse.rawPayload.subarray(-48);
    assert.equal(footer.subarray(0, 8).toString("ascii"), "DMDASH01");
    const embeddedLength = Number(footer.readBigUInt64LE(8));
    const embedded = exeResponse.rawPayload.subarray(-48 - embeddedLength, -48);
    assert.deepEqual(new Uint8Array(embedded), verified.archive.artifact);
    assert.equal(sha(embedded), footer.subarray(16).toString("hex"));
    if (sampleChart) {
      execFileSync(process.execPath, [fileURLToPath(new URL("./verify-dashboard-standalone.mjs", import.meta.url)),
        path.join(standaloneDirectory, "Dashboard.exe"), path.join(directory, "runtime-package.json"),
        path.join(directory, "standalone-validation")], { windowsHide: true, stdio: "inherit", timeout: 30_000 });
    }
    const zip = await JSZip.loadAsync(zipResponse.rawPayload, { checkCRC32: true });
    const manifest = JSON.parse(await zip.file("manifest.json").async("text"));
    const extracted = path.join(directory, "extracted"); await mkdir(extracted);
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert(!name.includes("/") && !name.includes("\\") && name !== "..", "Unexpected ZIP entry");
      const bytes = await zip.file(name).async("nodebuffer"); assert.equal(sha(bytes), hash);
      await writeFile(path.join(extracted, name), bytes);
    }
    await writeFile(path.join(extracted, "manifest.json"), JSON.stringify(manifest, null, 2));
    assert.deepEqual(new Uint8Array(await zip.file("runtime-package.json").async("uint8array")), verified.archive.artifact);
    assert.equal(manifest.artifactSha256, candidate.targetArtifactHash);
    assert.equal(sha(await zip.file("deep-native-player.exe").async("uint8array")), sha(await readFile(nativeExecutable)));
    assert.equal((await app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip?nativeExecutable=other.exe` })).statusCode, 400);
    registered.registry.remove(candidate.candidateId);
    assert.equal((await app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/standalone-executable` })).statusCode, 404);
    const evidence = { scope: "isolated-published-application-to-portable-zip", verifiedAt: new Date().toISOString(),
      content: sampleChart ? "published-author-sample-bar-37-91" : "shapes",
      standaloneNoArgumentVerified: sampleChart,
      testDataOnly: true, loginAuthenticationTested: false, nativeExecutableSha256: sha(await readFile(nativeExecutable)),
      candidate, capability: record.candidate.capability, windowVerification: record.candidate.windowVerification,
      zipSha256: sha(zipResponse.rawPayload), zipBytes: zipResponse.rawPayload.byteLength,
      standaloneSha256: sha(exeResponse.rawPayload), standaloneBytes: exeResponse.rawPayload.byteLength, manifest };
    await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ status: "passed", directory, zipBytes: evidence.zipBytes, candidateId: candidate.candidateId,
      artifactSha256: candidate.targetArtifactHash, deviceFingerprint, objects: candidate.objects }));
  } finally { await app.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
