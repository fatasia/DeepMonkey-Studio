import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { bindDashboardWindowEvidence } from "./dashboardWindowEvidence.mjs";
import { createDashboardNativeWindowVerifier } from "./dashboardNativeWindowVerifier.mjs";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function fixture() {
  const runtime = { schemaVersion: 5, packageHash: { value: "package-hash" }, entrypoints: { dashboard: "dashboard" },
    payloads: { dashboard: { entryPageId: "p1", pages: [{ id: "p1", nodes: [
      { id: "n1", visible: true, deep2d: "static1", chart: null },
      { id: "n2", visible: true, deep2d: "static2", chart: null },
    ] }] }, static1: { atlases: [{ id: "text-raster", kind: "image" }] }, static2: { atlases: [] } } };
  const artifact = Buffer.from(JSON.stringify(runtime)), digest = createHash("sha256").update(artifact).digest("hex");
  const input = { artifact, candidate: { authority: { publicationId: "publication" },
    document: { application: { pages: [{ nodes: [{ id: "author1" }, { id: "author2" }] }] } },
    manifest: { manifestSha256: "manifest", resources: [{ id: "font", kind: "font", sha256: "font-hash", faceIndex: 0, nodeIds: ["author1"] }] } },
    sourceSemanticHash: "source", compileGraphHash: "compile", targetArtifactHash: digest,
    windowEvidence: { nodeBindings: [
      { nodeId: "author1", runtimeNodeId: "n1", pageId: "p1", staticResourceId: "static1" },
      { nodeId: "author2", runtimeNodeId: "n2", pageId: "p1", staticResourceId: "static2" },
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
test("an unused font remains unattested even when it is in the frozen manifest", () => {
  const f = fixture(); f.receipt.report.layers[0].atlasIds = [];
  assert.deepEqual(f.bind().fontSha256, []);
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
