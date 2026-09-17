import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { dashboardFrozenRasterInput } from "./lib/dashboardFrozenRasterInput.mjs";
import { dashboardCompiledWindowEvidence } from "./lib/dashboardCompiledWindowEvidence.mjs";
import { createDashboardContentCompiler } from "../apps/api/dist/dashboard-content-compiler/compiler.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(value));
}
const configuration = { locale: "zh-CN", packageVersion: "1.0.0" };
function runtimeHash(value) {
  const number = value => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return `n${bytes.toString("hex")}`; };
  const wire = value => typeof value === "number" ? number(value)
    : Array.isArray(value) ? `[${value.map(wire).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${wire(value[key])}`).join(",")}}`
    : JSON.stringify(value);
  return hash(`deep-engine.runtime-package.canonical.v1\n${wire(value)}`);
}
async function frozen(nodes, resources = [], data = []) {
  const document = JSON.parse(await readFile(new URL("../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url)));
  document.application.pages = [document.application.pages[0]];
  document.application.pages[0].nodes = nodes;
  document.application.scripts = []; document.application.interactions = [];
  const manifest = { schema: "deep-engine.dashboard-publication-freeze", schemaVersion: 1,
    authority: { projectId: document.application.metadata.projectId, applicationId: document.application.metadata.id,
      applicationRevision: document.application.metadata.revision, publicationId: "test-publication" },
    entryPageId: document.entryPageId, documentSha256: hash(canonical(document)),
    resources: resources.map(({ bytes, ...item }) => ({ ...item, bytes: bytes.length, sha256: hash(bytes) })),
    data: data.map(({ value, ...item }) => ({ ...item, bytes: Buffer.byteLength(canonical(value)), sha256: hash(canonical(value)) })),
    totalBytes: resources.reduce((sum, resource) => sum + resource.bytes.length, 0)
      + data.reduce((sum, item) => sum + Buffer.byteLength(canonical(item.value)), 0) };
  return { document, resources: Object.fromEntries(resources.map(item => [item.id, item.bytes])),
    data: Object.fromEntries(data.map(item => [item.id, item.value])),
    freezeManifest: { ...manifest, manifestSha256: hash(canonical(manifest)) } };
}
const node = type => ({ id: type, kind: "data-widget", zIndex: 0,
  frame: { x: 0, y: 0, width: 120, height: 120 }, widget: { type, title: "Frozen", key: type, unit: "" } });
const resource = (id, kind, nodeId, bytes) => ({ id, kind, nodeIds: [nodeId], bytes, objectKey: `projects/test/${id}`,
  revision: 3, mime: kind === "font" ? "font/ttf" : "image/png", ...(kind === "font" ? { faceIndex: 0, licenseEvidence: "test-only" } : {}) });

test("frozen resources retain face/revision and explicit fallback order", async () => {
  const input = await frozen([node("text")], [resource("z-primary", "font", "text", new Uint8Array([1])),
    resource("a-fallback", "font", "text", new Uint8Array([2]))]);
  assert.throws(() => dashboardFrozenRasterInput(input, configuration), /font order/);
  const result = dashboardFrozenRasterInput(input, { ...configuration, nodeAssets: { text: { fonts: ["z-primary", "a-fallback"] } } });
  assert.deepEqual(result.nodeAssets.text.fonts, ["z-primary", "a-fallback"]);
  assert.equal(result.assets["z-primary"].faceIndex, 0);
  assert.equal(result.assets["z-primary"].identity.revision, 3);
  result.assets["z-primary"].bytes[0] = 9;
  assert.equal(input.resources["z-primary"][0], 1);
});

test("actual Native producer consumes the explicitly frozen font face", {
  skip: !process.env.C2_NATIVE_EXECUTABLE || !process.env.C2_FONT_PATH,
}, async () => {
  const text = node("text"); text.widget.content = "中文 é";
  const bytes = new Uint8Array(await readFile(process.env.C2_FONT_PATH));
  const input = await frozen([text], [resource("explicit-test-font", "font", "text", bytes)]);
  const compiler = await createDashboardContentCompiler({ nativeExecutable: process.env.C2_NATIVE_EXECUTABLE,
    configuration: { ...configuration, nodeAssets: { text: { textStyle: { fontSize: 16, fontWeight: 400,
      fontStyle: "normal", lineHeight: 22, color: [255, 255, 255, 255], align: "left" } } } } });
  const result = await compiler.compile(input);
  assert.equal(result.objects[0].contentCompiled, true);
  assert.ok(result.windowEvidence.fontBindings.length > 0);
  const fontBinding = result.windowEvidence.fontBindings[0];
  assert.equal(fontBinding.resourceId, "explicit-test-font");
  assert.equal(fontBinding.sha256, hash(bytes));
  assert.ok(result.windowEvidence.nodeBindings.some(binding => binding.runtimeNodeId === fontBinding.runtimeNodeId));
  if (process.env.C2_VERIFY_WINDOW === "1") {
    const { createDashboardNativeDeployment } = await import("../apps/api/dist/dashboard-content-compiler/deployment.mjs");
    const deployment = await createDashboardNativeDeployment({ nativeExecutable: process.env.C2_NATIVE_EXECUTABLE, configuration });
    const receipt = await deployment.verifier.verify({ artifact: result.artifact, windowEvidence: result.windowEvidence,
      candidate: { document: input.document, manifest: input.freezeManifest, authority: input.freezeManifest.authority },
      sourceSemanticHash: "a".repeat(64), compileGraphHash: "b".repeat(64), targetArtifactHash: hash(result.artifact) });
    assert.deepEqual(receipt.renderedNodeIds, ["text"]);
    assert.deepEqual(receipt.fontSha256, [{ resourceId: "explicit-test-font", sha256: hash(bytes), faceIndex: 0 }]);
  }
  const payloads = Object.values(JSON.parse(new TextDecoder().decode(result.artifact)).payloads);
  assert.ok(payloads.some(value => value.atlases?.some(atlas => Buffer.from(atlas.dataBase64, "base64").some(byte => byte > 0))));
});

test("window evidence rejects atlas bytes that differ from the producer receipt", () => {
  const result = { package: { payloads: {
    dashboard: { schema: "deep-engine.dashboard-runtime", pages: [{ id: "page", nodes: [{ id: "runtime", deep2d: "static" }] }] },
    static: { atlases: [{ id: "atlas", dataBase64: Buffer.from([1]).toString("base64") }] },
  } }, nodeBindings: [{ nodeId: "author", runtimePageId: "page", runtimeNodeIds: ["runtime"] }],
  producerEvidence: [{ nodeId: "author", atlasId: "atlas", pixelSha256: hash(Buffer.from([2])), usedFaces: [] }] };
  assert.throws(() => dashboardCompiledWindowEvidence(result, { nodeAssets: {}, assets: {} }), /atlas bytes/);
  result.producerEvidence[0].pixelSha256 = hash(Buffer.from([1]));
  assert.deepEqual(dashboardCompiledWindowEvidence(result, { nodeAssets: {}, assets: {} }).fontBindings, []);
});

test("page background reaches the real Native window without author or font credit", {
  skip: !process.env.C2_NATIVE_EXECUTABLE,
}, async () => {
  const pixels = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 10, g: 80, b: 150, alpha: 1 } } }).png().toBuffer();
  const image = { ...resource("background", "image", "unused", new Uint8Array(pixels)), nodeIds: [], pageIds: ["page-main"] };
  const input = await frozen([], [image]);
  const page = input.document.application.pages[0];
  page.width = 320; page.height = 320;
  page.appearance = { backgroundImageUrl: `/assets/${image.objectKey}`, backgroundImageFit: "original", backgroundImageRepeat: true };
  input.freezeManifest.documentSha256 = hash(canonical(input.document));
  const { manifestSha256, ...body } = input.freezeManifest;
  input.freezeManifest.manifestSha256 = hash(canonical(body));
  const { createDashboardNativeDeployment } = await import("../apps/api/dist/dashboard-content-compiler/deployment.mjs");
  const deployment = await createDashboardNativeDeployment({ nativeExecutable: process.env.C2_NATIVE_EXECUTABLE, configuration });
  const result = await deployment.compiler.compile(input);
  assert.equal(result.windowEvidence.backgroundBindings.length, 1);
  assert.deepEqual(result.windowEvidence.fontBindings, []);
  const pkg = JSON.parse(new TextDecoder().decode(result.artifact));
  const atlas = Object.values(pkg.payloads).flatMap(value => value.atlases ?? [])[0];
  assert.deepEqual([...Buffer.from(atlas.dataBase64, "base64").subarray(0, 4)], [10, 80, 150, 255]);
  const receipt = await deployment.verifier.verify({ artifact: result.artifact, windowEvidence: result.windowEvidence,
    candidate: { document: input.document, manifest: input.freezeManifest, authority: input.freezeManifest.authority },
    sourceSemanticHash: "a".repeat(64), compileGraphHash: "b".repeat(64), targetArtifactHash: hash(result.artifact) });
  assert.deepEqual(receipt.renderedNodeIds, []); assert.deepEqual(receipt.fontSha256, []);
});

test("rejects corrupted frozen bytes, extra resources and manifest changes", async () => {
  const input = await frozen([node("image")], [resource("img", "image", "image", new Uint8Array([1, 2]))]);
  const corrupt = structuredClone(input); corrupt.resources.img[0] = 9;
  assert.throws(() => dashboardFrozenRasterInput(corrupt, configuration), /bytes mismatch/);
  const extra = structuredClone(input); extra.resources.unbound = new Uint8Array([3]);
  assert.throws(() => dashboardFrozenRasterInput(extra, configuration), /outside/);
  input.freezeManifest.resources[0].nodeIds = ["other"];
  assert.throws(() => dashboardFrozenRasterInput(input, configuration), /manifest\/document mismatch/);
});

test("maps data by manifest node ID and rejects ambiguous node data", async () => {
  const value = { source: { id: "actual-dataset", kind: "dataset", revision: 2 }, metric: { samples: [] } };
  const input = await frozen([node("bar")], [], [{ id: "binding-17", nodeId: "bar", sourceRevision: "2", value }]);
  assert.deepEqual(dashboardFrozenRasterInput(input, configuration).data.bar, value);
  const duplicate = await frozen([node("bar")], [], ["a", "b"].map(id => ({ id, nodeId: "bar", sourceRevision: "2", value })));
  assert.throws(() => dashboardFrozenRasterInput(duplicate, configuration), /Ambiguous/);
});

test("real sharp pixels and frozen chart values reach canonical runtime v5", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-compiler-test-"));
  try {
    // Image/chart compilation must not start this deliberately non-executable text producer.
    const nativeExecutable = path.join(directory, "unused-producer"); await writeFile(nativeExecutable, "not executable");
    const compiler = await createDashboardContentCompiler({ nativeExecutable, configuration });
    const bytes = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 4,
      background: { r: 10, g: 80, b: 150, alpha: 1 } } }).png().toBuffer());
    const chart = node("bar"); chart.widget.analysis = { dimensionField: "region", measureField: "value", aggregation: "sum" };
    const metric = { samples: [], rows: [{ region: "A", value: 37 }, { region: "B", value: 91 }] };
    const source = await frozen([node("image"), chart], [resource("private-image", "image", "image", bytes)],
      [{ id: "private-data-binding", nodeId: "bar", sourceRevision: "7", value: {
        source: { kind: "dataset", id: "private-dataset", revision: 7, contentSha256: runtimeHash(metric) }, metric } }]);
    const result = await compiler.compile(source);
    const pkg = JSON.parse(new TextDecoder().decode(result.artifact));
    assert.equal(pkg.schemaVersion, 5);
    const contents = Object.values(pkg.payloads);
    const atlas = contents.flatMap(value => value.atlases ?? []).find(atlas => atlas.width === 86 && atlas.height === 86);
    assert.ok(atlas);
    assert.deepEqual([...Buffer.from(atlas.dataBase64, "base64").subarray(0, 4)], [10, 80, 150, 255]);
    const chartPayload = contents.find(value => value.schema === "deep-engine.chart-runtime");
    assert.deepEqual(chartPayload.chart.datasets[0].rows, [["A", 37], ["B", 91]]);
    assert.ok(result.objects.every(object => object.contentCompiled && object.deferredFields.includes("runtime.interactions")));
    const again = await compiler.compile(source); assert.deepEqual(result.artifact, again.artifact);
    await writeFile(nativeExecutable, "changed");
    await assert.rejects(compiler.compile(source), /producer changed/);
    const abort = new AbortController(); abort.abort(); await assert.rejects(compiler.compile(source, abort.signal), /abort/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
