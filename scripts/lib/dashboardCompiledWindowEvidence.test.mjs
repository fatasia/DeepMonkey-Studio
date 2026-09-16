import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dashboardCompiledWindowEvidence } from "./dashboardCompiledWindowEvidence.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
function fixture() {
  const pixels = Buffer.from([1, 2, 3, 4]), sha256 = hash(pixels);
  const evidence = { nodeId: "node", atlasId: "atlas", pixelSha256: sha256, usedFaces: [{ sha256: "font", faceIndex: 0 }], producerEvidence: { pixelSha256: sha256 } };
  return { result: { package: { payloads: { dashboard: { schema: "deep-engine.dashboard-runtime", pages: [{ id: "page", nodes: [{ id: "runtime", deep2d: "layer" }] }] }, layer: { atlases: [{ id: "atlas", dataBase64: pixels.toString("base64") }] } } }, nodeBindings: [{ nodeId: "node", runtimePageId: "page", runtimeNodeIds: ["runtime"] }], producerEvidence: [evidence] }, input: { nodeAssets: { node: { fonts: ["f"] } }, assets: { f: { sha256: "font", faceIndex: 0 } } }, evidence };
}
test("legacy direct atlas evidence remains exact", () => {
  const f = fixture(); assert.equal(dashboardCompiledWindowEvidence(f.result, f.input).fontBindings.length, 1);
  f.evidence.producerEvidence.pixelSha256 = "fake";
  assert.throws(() => dashboardCompiledWindowEvidence(f.result, f.input), /trusted text producer/);
});
test("transformed pixels cannot bypass trusted replay with self-reported hashes", () => {
  const f = fixture(); f.evidence.composition = { sourcePixelSha256: "source" };
  f.evidence.producerEvidence.pixelSha256 = "source";
  assert.throws(() => dashboardCompiledWindowEvidence(f.result, f.input), /trusted pixel replay/);
  assert.throws(() => dashboardCompiledWindowEvidence(f.result, f.input, () => { throw new Error("replay rejected"); }), /replay rejected/);
  f.evidence.pixelSha256 = "fake";
  assert.throws(() => dashboardCompiledWindowEvidence(f.result, f.input, () => {}), /compiled atlas bytes/);
});

