import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertDashboardAtlasEvidence } from "./dashboardAtlasEvidence.mts";
const pixels = Buffer.from([0, 255]);
const source = { id: "frozen-title", width: 2, height: 1, format: "r8unorm", kind: "glyph", sampling: "linear" };
const runtime = Buffer.from(JSON.stringify({ payloads: { title: { atlases: [{ ...source, dataBase64: pixels.toString("base64") }] } } }));
const prepared = { ...source, id: "dashboard.namespaced", bytes: 2, sha256: createHash("sha256").update(pixels).digest("hex") };
const log = (atlases: unknown[]) => `native Deep2d atlas inventory: ${JSON.stringify(atlases)}\nnative Deep2d atlases prepared: atlases=${atlases.length} bytes=${atlases.length * 2} glyph_quads=3 image_quads=0 batches=2 vertices=18`;
test("frozen pixels match despite namespacing and generated chart labels", () => {
  const result = assertDashboardAtlasEvidence(log([prepared, { ...prepared, id: "generated", sha256: "different" }]), runtime);
  assert.equal(result.frozen, 1); assert.equal(result.generated, 1);
  assert.equal(result.matches[0]!.preparedId, "dashboard.namespaced");
});
test("equal counts cannot hide lost, changed or duplicated frozen pixels", () => {
  assert.throws(() => assertDashboardAtlasEvidence(log([{ ...prepared, sha256: "wrong" }]), runtime), /missing from renderer/);
  assert.throws(() => assertDashboardAtlasEvidence(log([{ ...prepared, width: 1 }]), runtime), /missing from renderer/);
  assert.throws(() => assertDashboardAtlasEvidence("atlases=1", runtime), /inventory is missing/);
  assert.throws(() => assertDashboardAtlasEvidence(log([prepared]).replace("bytes=2", "bytes=3"), runtime), /pixel bytes mismatch/);
  const duplicate = Buffer.from(JSON.stringify({ payloads: { title: { atlases: [1, 2].map(() => ({ ...source, dataBase64: pixels.toString("base64") })) } } }));
  assert.throws(() => assertDashboardAtlasEvidence(log([prepared]), duplicate), /missing from renderer/);
});
