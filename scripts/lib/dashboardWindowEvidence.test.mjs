import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { bindDashboardWindowEvidence } from "./dashboardWindowEvidence.mjs";
import { createDashboardNativeWindowVerifier } from "./dashboardNativeWindowVerifier.mjs";
import { compiledBackgroundBindings } from "./dashboardBackgroundEvidence.mjs";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function fixture() {
  const pageId = `page.${hash(JSON.stringify(["application", "page-main", "page-main"]))}`;
  const runtime = { schemaVersion: 5, packageHash: { value: "package-hash" }, entrypoints: { dashboard: "dashboard" },
    payloads: { dashboard: { entryPageId: pageId, pages: [{ id: pageId, nodes: [
      { id: "n1", visible: true, deep2d: "static1", chart: null },
      { id: "n2", visible: true, deep2d: "static2", chart: null },
    ] }] }, static1: { atlases: [{ id: "text-raster", kind: "image" }] }, static2: { atlases: [] } } };
  const artifact = Buffer.from(JSON.stringify(runtime)), digest = createHash("sha256").update(artifact).digest("hex");
  const input = { artifact, candidate: { authority: { publicationId: "publication" },
    document: { application: { metadata: { id: "application" }, pages: [{ id: "page-main", nodes: [{ id: "author1" }, { id: "author2" }] }] } },
    manifest: { manifestSha256: "manifest", resources: [{ id: "font", kind: "font", sha256: "font-hash", faceIndex: 0, nodeIds: ["author1"] }] } },
    sourceSemanticHash: "source", compileGraphHash: "compile", targetArtifactHash: digest,
    windowEvidence: { nodeBindings: [
      { nodeId: "author1", runtimeNodeId: "n1", pageId, staticResourceId: "static1" },
      { nodeId: "author2", runtimeNodeId: "n2", pageId, staticResourceId: "static2" },
    ], fontBindings: [{ resourceId: "font", sha256: "font-hash", faceIndex: 0, runtimeNodeId: "n1", atlasId: "text-raster" }] } };
  const device = { name: "GPU", backend: "Vulkan", vendor_id: 4318, device_id: 10400 };
  const receipt = { sourceSha256: digest, nonce: "nonce", requestedFrames: 3, report: {
    packageHash: runtime.packageHash.value, scope: "native-window", gpuErrorsClean: true, presentedFrames: 3,
    nonce: "nonce", backend: "Vulkan", device, deviceFingerprintSha256: hash(device),
    layers: [{ id: "n1:static", drawCalls: 1, vertices: 6, atlasIds: [`dashboard.${hash(["n1:static", "text-raster"])}`] }],
  } };
  return { input, runtime, receipt, bind: () => bindDashboardWindowEvidence(input, runtime, receipt, hash) };
}

test("only attests the node and font atlas actually drawn, not every declared node", () => {
  const f = fixture(), result = f.bind();
  assert.deepEqual(result.renderedNodeIds, ["author1"]);
  assert.deepEqual(result.fontSha256, [{ resourceId: "font", sha256: "font-hash", faceIndex: 0 }]);
  assert.equal(result.fixtureSha256, f.input.targetArtifactHash);
});

test("attests only the initial filter-selected static layers", () => {
  const f = fixture();
  f.runtime.payloads.dashboard.pages[0].nodes[0].visible = false;
  f.runtime.payloads.dashboard.filter = { options: [{ visibility: [{ nodeId: "n1", visible: true }] }] };
  assert.deepEqual(f.bind().renderedNodeIds, ["author1"]);
  f.runtime.payloads.dashboard.filter.options[0].visibility[0].visible = false;
  assert.throws(f.bind, /draw layer is not on/);
});
test("an unused font remains unattested even when it is in the frozen manifest", () => {
  const f = fixture(); f.receipt.report.layers[0].atlasIds = [];
  assert.deepEqual(f.bind().fontSha256, []);
});
test("rejects evidence assigning a drawn layer to an author on another page", () => {
  const f = fixture();
  f.input.candidate.document.application.pages.push({ id: "page-other", nodes: [{ id: "foreign-author" }] });
  f.input.windowEvidence.nodeBindings[0].nodeId = "foreign-author";
  assert.throws(f.bind, /invalid node binding/);
});
function withBackground() {
  const f = fixture(), page = f.runtime.payloads.dashboard.pages[0];
  page.width = 100; page.height = 80;
  const id = `node.${hash([page.id, "background"])}`;
  page.nodes.unshift({ id, visible: true, zOrder: 0, clip: null, chart: null, chartSim: null, hitId: null,
    frame: [0, 0, 100, 80], deep2d: `${page.id}.background` });
  f.runtime.payloads[`${page.id}.background`] = { schema: "deep-engine.deep2d-runtime", atlases: [] };
  f.receipt.report.layers.unshift({ id: `${id}:static`, drawCalls: 1, vertices: 6, atlasIds: [] });
  return f;
}
function withBackgroundImage() {
  const f = withBackground(), page = f.runtime.payloads.dashboard.pages[0];
  const content = f.runtime.payloads[`${page.id}.background`];
  content.id = `${page.id}.background`;
  const pixels = Buffer.from([10, 20, 30, 255]);
  content.atlases = [{ id: `${content.id}.image`, dataBase64: pixels.toString("base64") }];
  const resource = { id: "image", kind: "image", pageIds: ["page-main"], sha256: hash("source"), objectKey: "projects/p/image.png" };
  f.input.candidate.manifest.resources.push(resource);
  f.input.candidate.document.application.pages[0].appearance = { backgroundImageUrl: `/assets/${resource.objectKey}` };
  f.input.windowEvidence.backgroundBindings = compiledBackgroundBindings({ package: f.runtime,
    pageImageEvidence: [{ pageId: "page-main", resourceId: "image", atlasId: content.atlases[0].id,
      pixelSha256: createHash("sha256").update(pixels).digest("hex") }] },
    { document: f.input.candidate.document, assets: { image: { sha256: resource.sha256 } }, pageAssets: { "page-main": { image: "image" } } },
    f.runtime.payloads.dashboard);
  const layer = f.receipt.report.layers[0];
  layer.atlasIds = [`dashboard.${hash([layer.id, content.atlases[0].id])}`];
  return f;
}
test("matches a presented page image to frozen ownership and exact pixel bytes without author credit", () => {
  const f = withBackgroundImage();
  assert.deepEqual(f.bind().renderedNodeIds, ["author1"]);
  f.receipt.report.layers.pop();
  assert.deepEqual(f.bind().renderedNodeIds, []);
  assert.deepEqual(f.bind().fontSha256, []);
});
test("rejects an omitted system background draw rather than silently accepting its receipt", () => {
  const f = withBackgroundImage(); f.receipt.report.layers.shift();
  assert.throws(f.bind, /missing presented system background/);
});
for (const [name, mutate] of [
  ["missing receipt", f => { delete f.input.windowEvidence.backgroundBindings; }],
  ["duplicate receipt", f => { f.input.windowEvidence.backgroundBindings.push(f.input.windowEvidence.backgroundBindings[0]); }],
  ["pixel tamper", f => { const id = f.runtime.payloads.dashboard.pages[0].nodes[0].deep2d; f.runtime.payloads[id].atlases[0].dataBase64 = "AQ=="; }],
  ["removed compiled atlas", f => { const id = f.runtime.payloads.dashboard.pages[0].nodes[0].deep2d; f.runtime.payloads[id].atlases = []; f.receipt.report.layers[0].atlasIds = []; }],
  ["resource owner", f => { f.input.candidate.manifest.resources.at(-1).pageIds = ["another-page"]; }],
  ["source hash", f => { f.input.windowEvidence.backgroundBindings[0].sourceSha256 = "changed"; }],
  ["unpresented atlas", f => { f.receipt.report.layers[0].atlasIds = []; }],
  ["page URL", f => { f.input.candidate.document.application.pages[0].appearance.backgroundImageUrl = "remote"; }],
]) test(`rejects background image ${name}`, () => {
  const f = withBackgroundImage(); mutate(f); assert.throws(f.bind, /invalid system background/);
});
test("system background draws do not attest an author node or unused font", () => {
  const f = withBackground();
  assert.deepEqual(f.bind().renderedNodeIds, ["author1"]);
  f.receipt.report.layers.pop();
  assert.deepEqual(f.bind().renderedNodeIds, []);
  assert.deepEqual(f.bind().fontSha256, []);
});
for (const [name, mutate] of [
  ["resource", f => { f.runtime.payloads.dashboard.pages[0].nodes[0].deep2d = "static1"; }],
  ["frame", f => { f.runtime.payloads.dashboard.pages[0].nodes[0].frame[2] = 99; }],
  ["atlas", f => { f.receipt.report.layers[0].atlasIds = ["text-raster"]; }],
  ["chart", f => { f.receipt.report.layers[0].id = f.receipt.report.layers[0].id.replace(":static", ":chart"); }],
]) test(`rejects substituted background ${name}`, () => {
  const f = withBackground(); mutate(f); assert.throws(f.bind, /invalid system background/);
});
for (const [name, mutate, reason] of [
  ["artifact replacement", f => { f.input.artifact = Buffer.from("changed"); }, /artifact bytes/],
  ["device spoof", f => { f.receipt.report.device.name = "Other GPU"; }, /device identity/],
  ["unpresented frame", f => { f.receipt.report.presentedFrames = 0; }, /unverified native present/],
  ["foreign draw", f => { f.receipt.report.layers[0].id = "foreign:static"; }, /verified entry page/],
  ["no issued vertices", f => { f.receipt.report.layers[0].vertices = 0; }, /invalid draw layer/],
  ["font face replacement", f => { f.input.windowEvidence.fontBindings[0].faceIndex = 1; }, /frozen closure/],
  ["absent font atlas", f => { f.input.windowEvidence.fontBindings[0].atlasId = "missing"; }, /atlas absent/],
]) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(f.bind, reason); });

test("factory gives exact artifact bytes to the native verifier and cleans up on success", async () => {
  const f = fixture(); let file;
  const verify = createDashboardNativeWindowVerifier({ nativeExecutable: "trusted.exe", runtimeContentSha256: hash,
    parseDeepRuntimePackage: () => ({ valid: true, value: f.runtime }),
    verifyNativeWindow: async options => { file = options.packagePath;
      assert.deepEqual(await readFile(file), f.input.artifact); assert.equal(options.frames, 3); return f.receipt; } });
  assert.deepEqual((await verify(f.input)).renderedNodeIds, ["author1"]);
  await assert.rejects(access(file));
});
test("factory cleans up on native failure and stops pre-cancelled requests before invoking it", async () => {
  const f = fixture(); let file, calls = 0;
  const verify = createDashboardNativeWindowVerifier({ nativeExecutable: "trusted.exe", runtimeContentSha256: hash,
    parseDeepRuntimePackage: () => ({ valid: true, value: f.runtime }),
    verifyNativeWindow: async options => { calls++; file = options.packagePath; throw new Error("GPU lost"); } });
  await assert.rejects(verify(f.input), /GPU lost/); await assert.rejects(access(file));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verify(f.input, controller.signal)); assert.equal(calls, 1);
});
