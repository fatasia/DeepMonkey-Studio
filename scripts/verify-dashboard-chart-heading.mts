import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareDashboardPublicationFreeze, dashboardCanonicalJsonSha256 } from "../apps/api/src/dashboardPublicationFreeze.ts";
import { dashboardDataRequestId } from "../apps/api/src/dashboardPublishedClosure.ts";
import { runtimeContentSha256, parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { serveDashboardHeadingPreview } from "./lib/dashboardHeadingPreview.mjs";
import { createDashboardChromiumLayoutHost } from "./lib/dashboardChromiumLayoutHost.mjs";
import { createDashboardNativeProcessVerifier } from "./lib/nativeWindowVerifier.mjs";

const root = process.cwd();
const nativeExecutable = process.env.C2_NATIVE_EXECUTABLE;
const fontPath = process.env.C2_FONT_PATH;
const boldFontPath = process.env.C2_BOLD_FONT_PATH;
if (!nativeExecutable || !fontPath || !boldFontPath) throw new Error("Set C2_NATIVE_EXECUTABLE, C2_FONT_PATH and C2_BOLD_FONT_PATH to verified local producer/font paths");
const output = path.join(root, "test-output/dashboard-chart-heading");
await mkdir(output, { recursive: true });
const document = JSON.parse(await readFile("packages/deep-engine/fixtures/dashboard-layout-source-v1.json", "utf8"));
document.application.scripts = []; document.application.interactions = [];
document.application.pages = [document.application.pages[0]];
const node = { id: "heading-chart", kind: "data-widget", zIndex: 1, frame: { x: 20, y: 30, width: 480, height: 280 },
  widget: { type: "bar", title: "Production output", key: "output", unit: "MW", fontSize: 18 } };
document.application.pages[0].nodes = [node];
const authority = { projectId: document.application.metadata.projectId, applicationId: document.application.metadata.id,
  publicationId: "chart-heading-verification", applicationRevision: document.application.metadata.revision };
const metric = { samples: [{ time: 0, value: 7 }, { time: 1, value: 9 }] };
const bytes = new Uint8Array(await readFile(fontPath));
const fontSha256 = createHash("sha256").update(bytes).digest("hex");
const boldBytes = new Uint8Array(await readFile(boldFontPath));
const boldSha256 = createHash("sha256").update(boldBytes).digest("hex");
const candidate = await prepareDashboardPublicationFreeze({ expected: authority, entryPageId: document.entryPageId,
  data: [{ id: dashboardDataRequestId(node.id), nodeId: node.id, sourceRevision: "sample:1" }],
  resources: [{ id: "heading-font", kind: "font", objectKey: `projects/${authority.projectId}/fonts/heading.ttf`, mime: "font/ttf", nodeIds: [node.id],
    revision: 1, faceIndex: 0, license: { redistributable: true, evidence: "OFL-1.1 local validation font; bytes not committed" } },
    { id: "heading-bold", kind: "font", objectKey: `projects/${authority.projectId}/fonts/heading-bold.ttf`, mime: "font/ttf", nodeIds: [node.id],
      revision: 1, faceIndex: 0, license: { redistributable: true, evidence: "OFL-1.1 local validation font; bytes not committed" } }],
  readAuthority: async () => ({ activePublicationId: authority.publicationId, currentApplicationRevision: authority.applicationRevision,
    publication: { id: authority.publicationId, projectId: authority.projectId, applicationId: authority.applicationId,
      applicationRevision: authority.applicationRevision, document: document.application, publishedAt: "2026-09-17T00:00:00.000Z" } }),
  resolveData: async () => ({ sourceRevision: "sample:1", value: { source: { kind: "sample", id: "heading-source", revision: 1,
    contentSha256: runtimeContentSha256(metric) }, metric } }),
  readResource: async request => ({ revision: 1, bytes: request.id === "heading-bold" ? boldBytes : bytes }),
});
const source = { document: candidate.document, freezeManifest: candidate.manifest, data: candidate.data, resources: candidate.resources };
const before = dashboardCanonicalJsonSha256(source.data);
const { createDashboardContentCompiler } = await import(pathToFileURL(path.join(root, "apps/api/dist/dashboard-content-compiler/compiler.mjs")).href);
const compiler = await createDashboardContentCompiler({ nativeExecutable, configuration: { locale: "en-US", packageVersion: "1.0.0",
  nodeAssets: { [node.id]: { fonts: ["heading-font", "heading-bold"] } },
  layoutCapture: { chromiumExecutable: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    playwrightModule: path.join(root, "apps/cloud-render-worker/node_modules/playwright-core/index.js") } } });
const result = await compiler.compile(source);
assert.equal(dashboardCanonicalJsonSha256(source.data), before);
assert.equal(result.objects[0].deferredFields.includes("widget.title"), false);
assert.equal(result.objects[0].deferredFields.includes("widget.unit"), false);
assert.equal(result.objects[0].deferredFields.includes("appearance.crossHost"), true);
const artifact = JSON.parse(new TextDecoder().decode(result.artifact));
const atlases = Object.values(artifact.payloads).flatMap((payload: any) => payload.atlases ?? []);
assert.equal(atlases.length, 2);
assert.ok(atlases.every((atlas: any) => Buffer.from(atlas.dataBase64, "base64").some((value, index) => index % 4 === 3 && value > 0)));
assert.ok(result.windowEvidence.fontBindings.length >= 2);
assert.ok(result.windowEvidence.fontBindings.every((binding: any) => [fontSha256, boldSha256].includes(binding.sha256)));
const again = await compiler.compile(source);
assert.deepEqual(again.artifact, result.artifact);
const controller = new AbortController(); controller.abort();
await assert.rejects(compiler.compile(source, controller.signal));
const captureHost = await createDashboardChromiumLayoutHost(compiler.configuration.layoutCapture,
  pathToFileURL(path.join(root, "apps/api/dist/dashboard-content-compiler/")));
const request = { protocol: "dashboard-measured-layout-v1", nodeId: node.id, logicalSize: [480, 280],
  widget: node.widget, data: { source: {}, metric }, locale: "en-US",
  fonts: [{ id: "heading-font", faceIndex: 0, bytes }, { id: "heading-bold", faceIndex: 0, bytes: boldBytes }] };
await assert.rejects(captureHost.capture({ ...request, fonts: request.fonts.slice(0, 1) }), /weight\/style/);
await assert.rejects(captureHost.capture({ ...request, fonts: [{ ...request.fonts[0], bytes: Uint8Array.of(0, 1, 2) }] }), /OpenType/);
const inFlight = new AbortController();
const interrupted = captureHost.capture(request, inFlight.signal);
setTimeout(() => inFlight.abort(), 30);
await assert.rejects(interrupted);
const recovered = await captureHost.capture(request);
assert.equal(recovered.layout.textBoxes.length, 2);
await writeFile(path.join(output, "package.json"), result.artifact);
// dashboard 候选窗口验证走 .dmda 正式链命令;scene `--verify-package` 对 dashboard 内容 fail-closed。
const nativeWindow = process.env.C2_VERIFY_WINDOW === "1" ? await createDashboardNativeProcessVerifier(parseDeepRuntimePackage)({
  packagePath: path.join(output, "package.json"), nativeExecutable, frames: 3,
}) : undefined;
await writeFile(path.join(output, "result.json"), JSON.stringify({ fontSha256, configuration: compiler.configuration,
  objects: result.objects, windowEvidence: result.windowEvidence, atlasCount: atlases.length, repeatedArtifactIdentical: true,
  failureChecks: ["pre-abort", "in-flight-abort", "missing-weight", "invalid-font"], recoveredAfterAbort: true, nativeWindow }, null, 2));
console.log("Frozen candidate → configured Chromium host → Native producer: 2 nonempty font-bound atlases; repeat identical; pre-abort rejected");
if (process.env.C2_HEADING_PREVIEW_PORT) await serveDashboardHeadingPreview(
  pathToFileURL(path.join(root, "apps/api/dist/dashboard-content-compiler/")), {
    widget: node.widget, metric, locale: "en-US", width: 480, height: 280,
    fonts: [{ id: "heading-font", base64: Buffer.from(bytes).toString("base64") },
      { id: "heading-bold", base64: Buffer.from(boldBytes).toString("base64") }],
  }, Number(process.env.C2_HEADING_PREVIEW_PORT));
