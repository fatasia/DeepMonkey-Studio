import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DashboardDataWidgetNode } from "../packages/contracts/src/index.ts";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { loadConfig } from "../apps/api/src/config.js";
import { registerConfiguredDashboardNative } from "../apps/api/src/dashboardNativeStartup.js";
import { parseDashboardOfflineArchive } from "../apps/api/src/dashboardOfflineArchiveBytes.js";
import { runDashboardOfflineNative } from "../apps/api/src/dashboardOfflineNativeProcess.js";
import { assertDashboardDocument } from "../packages/contracts/src/index.ts";
import { parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { dashboardAcceptanceHttp, publishDashboardAcceptanceFixture } from "./lib/dashboardAcceptanceHttp.mts";
import { dashboardMulticomponentFixture } from "./lib/dashboardMulticomponentFixture.mts";
import { verifyDashboardDownloadedOpen } from "./lib/dashboardDownloadedOpen.mts";
import { createDashboardChromiumLayoutHost } from "./lib/dashboardChromiumLayoutHost.mjs";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const JSZip = require("jszip");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const usage = "pnpm exec tsx --conditions=development scripts/verify-dashboard-multicomponent-portable.mts <native.exe> <device-sha256> <new-output-directory>";

const PRESENTED = "native package recovery checkpoint committed after present";
const playerEnv = (localAppData: string) => ({
  ...process.env, LOCALAPPDATA: localAppData,
  PATH: path.join(process.env.SystemRoot ?? "C:/Windows", "System32"),
});

/** 中文多组件页面：横幅文本 + KPI(value) + 筛选(filter) + 柱状图(bar) + 表格(table)。 */
function multicomponentNodes(): DashboardDataWidgetNode[] {
  const panel = { backgroundColor: "#172126", backgroundOpacity: 0.86 };
  // 横幅高度 72 = 内容 inset(17×2) + 22px 字号行距 33 的实际内容盒;过矮会把字形压扁进 10px 内容盒。
  return [
    { id: "mc-text", kind: "data-widget", zIndex: 0, frame: { x: 20, y: 16, width: 920, height: 72 },
      widget: { type: "text", title: "冷热电联供园区运行总览", content: "冷热电联供园区运行总览",
        key: "banner.title", unit: "", fontSize: 22, textColor: "#eef2f4", textAlign: "left" } },
    { id: "mc-kpi", kind: "data-widget", zIndex: 1, frame: { x: 20, y: 100, width: 224, height: 132 },
      widget: { type: "value", title: "总有功功率", key: "kpi.power", unit: "MW", field: "value", fontSize: 20,
        ...panel, analysis: { measureField: "value", aggregation: "maximum" },
        sampleData: { sourceId: "mc-kpi-samples", rows: [{ region: "华东", value: 37 }, { region: "华北", value: 91 }] } } },
    { id: "mc-filter", kind: "data-widget", zIndex: 2, frame: { x: 20, y: 244, width: 224, height: 286 },
      widget: { type: "filter", title: "区域筛选", key: "filter.region", unit: "",
        options: ["全部区域", "华东", "华北", "华南"], filterMode: "select", filterField: "region", ...panel } },
    { id: "mc-bar", kind: "data-widget", zIndex: 3, frame: { x: 256, y: 100, width: 440, height: 430 },
      widget: { type: "bar", title: "分区域出力", key: "bar.output", unit: "MW", field: "value", fontSize: 18,
        analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" },
        sampleData: { sourceId: "mc-bar-samples",
          rows: [{ region: "华东", value: 37 }, { region: "华北", value: 91 }, { region: "华南", value: 58 }] } } },
    { id: "mc-table", kind: "data-widget", zIndex: 4, frame: { x: 708, y: 100, width: 232, height: 430 },
      widget: { type: "table", title: "机组运行表", key: "table.rows", unit: "", ...panel,
        report: { mode: "detail", rowField: "机组", valueFields: ["出力(MW)", "状态"], aggregation: "none",
          showRowNumbers: true, stripedRows: true },
        analysis: { dimensionField: "机组", measureField: "出力(MW)", aggregation: "none" },
        sampleData: { sourceId: "mc-table-samples", rows: [
          { "机组": "1号燃机", "出力(MW)": 42.5, "状态": "运行" }, { "机组": "2号燃机", "出力(MW)": 38.2, "状态": "运行" },
          { "机组": "储能", "出力(MW)": 12, "状态": "充电" }, { "机组": "余热锅炉", "出力(MW)": 0, "状态": "检修" }] } } },
  ];
}

/** 诚实边界探针：value 组件是否真的能进入受信任测量采集（部署的采集宿主只实现了 chart 根）。 */
async function probeValueWidgetMeasuredCapture(directory: string, fixture: Awaited<ReturnType<typeof dashboardMulticomponentFixture>>,
  projectId: string) {
  const host = await createDashboardChromiumLayoutHost(fixture.layoutCapture,
    new URL("../apps/api/dist/dashboard-content-compiler/", import.meta.url));
  try {
    const fontBytes = await Promise.all([400, 700].map(async weight => ({
      id: `notocjk-${weight}`, faceIndex: 0,
      bytes: new Uint8Array(await readFile(path.join(directory, "isolated-objects", "projects", projectId,
        `fonts/notocjk-${weight}.otf`))),
    })));
    await host.capture({
      protocol: "dashboard-measured-layout-v1", nodeId: "mc-kpi", logicalSize: [224, 132],
      widget: { type: "value", title: "总有功功率", key: "kpi.power", unit: "MW", fontSize: 20 },
      data: { source: { kind: "sample", id: "mc-kpi-samples", revision: 1, contentSha256: "probe" },
        metric: { value: 91, rows: [{ region: "华东", value: 37 }, { region: "华北", value: 91 }], samples: [] } },
      fonts: fontBytes, locale: "zh-CN",
    });
    return { nodeId: "mc-kpi", threw: false, note: "value 组件被测量宿主接受——与预期缺口不符,需人工复核" };
  } catch (error) {
    return { nodeId: "mc-kpi", threw: true, error: error instanceof Error ? error.message : String(error),
      note: "部署的测量采集宿主只查询 chart 捕获根,value/table 组件无法进入测量静态视图" };
  }
}

async function hashInventory(directory: string) {
  const entries: Array<{ file: string; sha256: string; bytes: number }> = [];
  async function walk(current: string) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) { await walk(full); continue; }
      const bytes = await readFile(full);
      entries.push({ file: path.relative(directory, full).replaceAll("\\", "/"), sha256: sha(bytes), bytes: bytes.byteLength });
    }
  }
  await walk(directory);
  return entries.sort((left, right) => left.file.localeCompare(right.file));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [executable, deviceFingerprint, output] = args;
  if (args.length !== 3 || !executable || !deviceFingerprint || !output || !/^[a-f0-9]{64}$/.test(deviceFingerprint)) throw new Error(usage);
  const directory = path.resolve(output);
  await mkdir(directory); // 既有证据不可覆盖。
  const nativeExecutable = path.resolve(executable);
  const deploymentFile = path.join(directory, "deployment.json");

  // 独立真实磁盘 store,不连接或修改用户数据库。
  const metadataDirectory = path.join(directory, "isolated-metadata");
  const initialStore = new JsonStore(metadataDirectory); await initialStore.init();
  const project = await initialStore.createProject("多组件中文页面 HTTP 离线交付验收", "隔离测试数据,非用户项目");
  const objects = new LocalObjectStore(path.join(directory, "isolated-objects"));
  const document: unknown = JSON.parse(await readFile(new URL("../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url), "utf8"));
  assertDashboardDocument(document);
  document.application.metadata.id = randomUUID();
  document.application.metadata.projectId = project.id;
  document.application.metadata.name = "多组件中文离线交付验收";
  document.application.scripts = []; document.application.interactions = []; document.application.scenes = [];
  const page = document.application.pages[0]!;
  page.width = 960; page.height = 540;
  page.nodes = multicomponentNodes();
  document.application.pages = [page];
  assertDashboardDocument(document);
  const published = await publishDashboardAcceptanceFixture(initialStore, project.id, document.application);
  const publicationId = published.id;
  // 重开文件存储,从落盘 publication/pointer 读取,不依赖内存草稿。
  const store = new JsonStore(metadataDirectory); await store.init();
  const persisted = store.getPublishedApplication(publicationId); assert(persisted);
  assert.deepEqual(persisted, published);
  const fixture = await dashboardMulticomponentFixture(directory, persisted);
  const configuration = { locale: "zh-CN", packageVersion: "1.0.0", layoutCapture: fixture.layoutCapture };
  await writeFile(deploymentFile, JSON.stringify({ nativeExecutable, expectedDeviceFingerprintSha256: deviceFingerprint,
    configuration, fontCatalog: fixture.fontCatalog }, null, 2));
  await writeFile(path.join(directory, "published-test-fixture.json"), JSON.stringify(persisted, null, 2));
  const app = createApiServer();
  // Fixture 身份行使路由项目权限;登录认证不在本门禁内。
  app.addHook("preHandler", async request => { request.systemUser = {
    id: "multicomponent-fixture-editor", role: "editor", enabled: true, projectIds: [project.id],
  } as never; });
  try {
    const registered = await registerConfiguredDashboardNative(app, { store, objects, config: loadConfig() }, deploymentFile);
    assert(registered);
    const request = await dashboardAcceptanceHttp(app);
    const base = `/api/projects/${project.id}/applications/${persisted.applicationId}/dashboard-candidates`;
    const response = await request({ method: "POST", url: base, payload: {
      publicationId, applicationRevision: persisted.applicationRevision, entryPageId: document.entryPageId,
    } });
    await writeFile(path.join(directory, "prepare-response.json"), response.body);
    assert.equal(response.statusCode, 201, response.body);
    const candidate = response.json();
    const record = registered.registry.read({ candidateId: candidate.candidateId, projectId: project.id, applicationId: persisted.applicationId });

    // 冻结清单:三个样本数据组件(KPI/表格/柱状图)进入数据冻结;筛选与文本无数据绑定。
    assert.deepEqual(record.candidate.freezeManifest.data.map(item => item.nodeId).sort(),
      ["mc-bar", "mc-kpi", "mc-table"]);
    assert.equal(record.candidate.freezeManifest.resources.filter(item => item.kind === "font").length, 2);
    const runtime = JSON.parse(new TextDecoder().decode(record.candidate.artifact.artifact));
    const charts = Object.values(runtime.payloads).filter((value: any) => value.schema === "deep-engine.chart-runtime") as any[];
    assert.equal(charts.length, 1, "柱状图必须产出 ChartIR 载荷");
    assert.deepEqual(charts[0]!.chart.datasets[0].rows, [["华东", 37], ["华北", 91], ["华南", 58]]);
    const deep2d = Object.values(runtime.payloads).filter((value: any) => value.schema === "deep-engine.deep2d-runtime") as any[];
    const expectedAtlasCount = deep2d.reduce((sum, content) => sum + (content.atlases?.length ?? 0), 0);
    assert(expectedAtlasCount >= 3, `横幅文本与图表标题至少产生 3 个字形图集,实际 ${expectedAtlasCount}`);
    const atlases = deep2d.flatMap(content => content.atlases ?? []) as any[];
    assert(atlases.every(atlas => Buffer.from(atlas.dataBase64, "base64").some((value, index) => index % 4 === 3 && value > 0)));

    // 能力报告:文本横幅与柱状图标题内容已编译(degraded);KPI/表格/筛选内容在 rasterNode 层 contentCompiled=false → blocked,
    // 其中筛选的矢量选项条与命中区仍随 deep2d 呈现(命令数见 player 日志)。
    const statusOf = new Map(record.candidate.capability.objects.map(object => [object.nodeId, object.status]));
    for (const nodeId of ["mc-text", "mc-bar"]) assert.equal(statusOf.get(nodeId), "degraded", nodeId);
    for (const nodeId of ["mc-kpi", "mc-filter", "mc-table"]) assert.equal(statusOf.get(nodeId), "blocked", nodeId);
    const deferredOf = new Map(record.candidate.capability.objects.map(object => [object.nodeId, object.deferredFields]));
    const deferred = (nodeId: string): readonly string[] => deferredOf.get(nodeId) ?? [];
    assert(!deferred("mc-bar").includes("widget.title") && !deferred("mc-bar").includes("widget.unit"));
    assert(!deferred("mc-text").includes("widget.content"));
    assert(!deferred("mc-filter").includes("widget.options"));
    // 渲染证明:五个对象都有可呈现的编译内容。
    assert.deepEqual([...record.candidate.windowVerification.renderedNodeIds].sort(),
      ["mc-bar", "mc-filter", "mc-kpi", "mc-table", "mc-text"]);
    assert(record.candidate.windowVerification.fontSha256.length >= 1, "渲染字体证据不能为空");

    await writeFile(path.join(directory, "runtime-package.json"), record.candidate.artifact.artifact);
    await writeFile(path.join(directory, "prepared-evidence.json"), JSON.stringify({ freezeManifest: record.candidate.freezeManifest,
      capability: record.candidate.capability, windowVerification: record.candidate.windowVerification }, null, 2));
    const measuredCaptureGap = await probeValueWidgetMeasuredCapture(directory, fixture, project.id);
    await writeFile(path.join(directory, "measured-capture-gap.json"), JSON.stringify(measuredCaptureGap, null, 2));

    // 真实 HTTP 三格式下载。
    const zipResponse = await request({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` });
    assert.equal(zipResponse.statusCode, 200, zipResponse.body);
    assert.equal(zipResponse.headers["content-type"], "application/zip");
    await writeFile(path.join(directory, "dashboard.zip"), zipResponse.rawPayload);
    const archiveResponse = await request({ method: "GET", url: `${base}/${candidate.candidateId}/offline-archive` });
    assert.equal(archiveResponse.statusCode, 200, archiveResponse.body);
    await writeFile(path.join(directory, "dashboard.dmda"), archiveResponse.rawPayload);
    const verified = parseDashboardOfflineArchive(archiveResponse.rawPayload);
    const exeResponse = await request({ method: "GET", url: `${base}/${candidate.candidateId}/standalone-executable` });
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

    // ZIP 解包核对:CRC、逐文件 SHA、运行包一致、无浏览器/Node 应用文件;解出的播放器供后续打开与截图。
    const zip = await JSZip.loadAsync(zipResponse.rawPayload, { checkCRC32: true });
    const manifest = JSON.parse(await zip.file("manifest.json").async("text"));
    const extracted = path.join(directory, "extracted"); await mkdir(extracted);
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert(!name.includes("/") && !name.includes("\\") && name !== "..", "Unexpected ZIP entry");
      const bytes = await (zip.file(name) as any).async("nodebuffer"); assert.equal(sha(bytes), hash);
      await writeFile(path.join(extracted, name), bytes);
    }
    await writeFile(path.join(extracted, "manifest.json"), JSON.stringify(manifest, null, 2));
    assert.deepEqual(new Uint8Array(await zip.file("runtime-package.json").async("uint8array")), verified.archive.artifact);
    assert.equal(manifest.artifactSha256, candidate.targetArtifactHash);
    assert.equal(sha(await zip.file("deep-native-player.exe").async("uint8array")), sha(await readFile(nativeExecutable)));
    assert(Object.keys(manifest.files).every(name => !/\.(?:js|mjs|cjs|html)$/i.test(name)), "离线 ZIP 不得携带浏览器/Node 应用");

    // 单 EXE 无参数运行:目录中只有该 EXE,PATH 仅 Windows System32。
    execFileSync(process.execPath, [fileURLToPath(new URL("./verify-dashboard-standalone.mjs", import.meta.url)),
      path.join(standaloneDirectory, "Dashboard.exe"), path.join(directory, "runtime-package.json"),
      path.join(directory, "standalone-validation")], { windowsHide: true, stdio: "inherit", timeout: 30_000 });
    assert((await readFile(path.join(directory, "standalone-validation/player.log"), "utf8")).includes(`atlases=${expectedAtlasCount}`));

    // ZIP/DMDA 下载产物的真实播放器打开(受控终止)。
    const downloadedOpen = await verifyDashboardDownloadedOpen(directory, archiveResponse.rawPayload,
      verified.archive.artifact, expectedAtlasCount);

    // 可见窗口截图:三个交付载体各一张真实窗口像素。
    const shotsDirectory = path.join(directory, "screenshots");
    const shots = [];
    shots.push(await captureNativePlayerWindow({ label: "standalone-exe-window",
      executable: path.join(standaloneDirectory, "Dashboard.exe"), args: [],
      env: playerEnv(path.join(shotsDirectory, "local-app-data-standalone")), outputDirectory: shotsDirectory, presentedMarker: PRESENTED }));
    shots.push(await captureNativePlayerWindow({ label: "zip-player-window",
      executable: path.join(directory, "extracted", "deep-native-player.exe"),
      args: ["--package", path.join(directory, "extracted", "runtime-package.json")],
      env: playerEnv(path.join(shotsDirectory, "local-app-data-zip")), outputDirectory: shotsDirectory, presentedMarker: PRESENTED }));
    {
      // DMDA 导入路径:正式启动器解包归档后可见启动,呈现后截图再受控终止。
      const controller = new AbortController();
      const finished = new Error("Acceptance stopped after DMDA screenshot");
      let log = "", presented = false, pid: number | undefined, handle: ReturnType<typeof spawn> | undefined;
      const pending = runDashboardOfflineNative(archiveResponse.rawPayload,
        path.join(directory, "extracted", "deep-native-player.exe"),
        { signal: controller.signal,
          spawnProcess: ((file: string, spawnArgs: readonly string[], options: Parameters<typeof spawn>[2]) => {
            const child = spawn(file, spawnArgs, { ...options, windowsHide: false, stdio: ["ignore", "pipe", "pipe"],
              env: playerEnv(path.join(shotsDirectory, "local-app-data-dmda")) });
            pid = child.pid; handle = child;
            const receive = (bytes: Buffer) => { log += bytes.toString(); if (log.includes(PRESENTED)) presented = true; };
            child.stdout!.on("data", receive); child.stderr!.on("data", receive);
            return child;
          }) as typeof spawn })
        .then(() => { throw new Error("DMDA player exited before the window capture"); },
          reason => { if (reason !== finished) throw reason; });
      const started = Date.now();
      while (!presented && Date.now() - started < 30_000) await sleep(200);
      assert(presented, `DMDA player never presented: ${log.slice(-600)}`);
      assert(typeof pid === "number");
      await sleep(2_500);
      const ps1 = path.join(shotsDirectory, "dmda-player-window-capture.ps1");
      await writeFile(ps1, await readFile(path.join(shotsDirectory, "standalone-exe-window-capture.ps1")));
      const capture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
        "-ProcId", String(pid), "-OutPath", path.join(shotsDirectory, "dmda-player-window.png")],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let captureOutput = "";
      capture.stdout!.on("data", bytes => { captureOutput += String(bytes); });
      capture.stderr!.on("data", bytes => { captureOutput += String(bytes); });
      const captureCode = await new Promise<number>((resolve, reject) => {
        const captureTimeout = setTimeout(() => reject(new Error(`DMDA 截图超时: ${captureOutput}`)), 20_000);
        capture.once("error", reason => { clearTimeout(captureTimeout); reject(reason); });
        capture.once("close", code => { clearTimeout(captureTimeout); resolve(code ?? -1); });
      });
      assert.equal(captureCode, 0, captureOutput);
      controller.abort(finished);
      await pending;
      if (handle && handle.exitCode === null && handle.signalCode === null) handle.kill();
      shots.push({ label: "dmda-player-window", png: path.join(shotsDirectory, "dmda-player-window.png"),
        pid, captureLog: captureOutput.trim(), playerLogHead: log.slice(0, 2_000) });
    }
    await writeFile(path.join(shotsDirectory, "screenshots.json"), JSON.stringify(shots, null, 2));

    // 失败路径:可执行文件查询被拒;候选删除后三种下载全部 404。
    assert.equal((await request({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip?nativeExecutable=other.exe` })).statusCode, 400);
    registered.registry.remove(candidate.candidateId);
    assert.equal((await request({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` })).statusCode, 404);
    assert.equal((await request({ method: "GET", url: `${base}/${candidate.candidateId}/standalone-executable` })).statusCode, 404);
    assert.equal((await request({ method: "GET", url: `${base}/${candidate.candidateId}/offline-archive` })).statusCode, 404);

    const evidence = { scope: "isolated-multicomponent-chinese-http-delivery", verifiedAt: new Date().toISOString(),
      content: "multicomponent-zh-CN text+value+filter+bar+table", transport: "loopback-http", publishedViaHttp: true,
      components: ["mc-text(text 中文横幅)", "mc-kpi(value KPI)", "mc-filter(filter 区域筛选)", "mc-bar(bar 分区域出力)", "mc-table(table 机组运行表)"],
      fontCatalog: fixture.fontCatalog, expectedAtlasCount, measuredCaptureGap, downloadedOpen, screenshots: shots,
      standaloneNoArgumentVerified: true, testDataOnly: true, loginAuthenticationTested: false,
      exeInteractionDriven: false,
      exeInteractionNote: "筛选点击等 EXE 内真实输入未驱动:原生窗口输入消费归 G01 宿主,合同级命中区已编译,未见自动化驱动证据",
      nativeExecutableSha256: sha(await readFile(nativeExecutable)),
      candidate, capability: record.candidate.capability, windowVerification: record.candidate.windowVerification,
      zipSha256: sha(zipResponse.rawPayload), zipBytes: zipResponse.rawPayload.byteLength,
      dmdaSha256: sha(archiveResponse.rawPayload), dmdaBytes: archiveResponse.rawPayload.byteLength,
      standaloneSha256: sha(exeResponse.rawPayload), standaloneBytes: exeResponse.rawPayload.byteLength,
      runtimePackageSha256: sha(record.candidate.artifact.artifact), manifest };
    await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ scope: "sha256-inventory",
      generatedAt: new Date().toISOString(), files: await hashInventory(directory) }, null, 2));
    console.log(JSON.stringify({ status: "passed", directory, zipBytes: evidence.zipBytes, dmdaBytes: evidence.dmdaBytes,
      standaloneBytes: evidence.standaloneBytes, candidateId: candidate.candidateId, artifactSha256: candidate.targetArtifactHash,
      expectedAtlasCount, objects: candidate.objects, screenshots: shots.map(shot => shot.png) }));
  } finally { await app.close(); }
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

main().catch(error => { console.error(error); process.exitCode = 1; });
