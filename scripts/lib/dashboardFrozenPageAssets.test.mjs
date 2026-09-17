import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dashboardFrozenRasterInput } from "./dashboardFrozenRasterInput.mjs";

const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => hash(JSON.stringify(sort(value)));
const configuration = { locale: "zh-CN", packageVersion: "1.0.0" };
function fixture() {
  const url = "/assets/projects/project/assets/image/background.png";
  const document = { entryPageId: "main", application: { metadata: { id: "app", projectId: "project", revision: 1 },
    pages: ["main", "second"].map(id => ({ id, nodes: [], appearance: { backgroundImageUrl: url } })) } };
  const bytes = Uint8Array.of(1, 2, 3);
  const body = { schema: "deep-engine.dashboard-publication-freeze", schemaVersion: 1,
    authority: { projectId: "project", applicationId: "app", applicationRevision: 1 }, entryPageId: "main",
    documentSha256: digest(document), data: [], resources: [{ id: "image", kind: "image", mime: "image/png",
      nodeIds: [], pageIds: ["main", "second"], revision: 1, objectKey: url.slice(8), bytes: bytes.length, sha256: hash(bytes) }] };
  return { document, data: {}, resources: { image: bytes }, freezeManifest: { ...body, manifestSha256: digest(body) } };
}
function seal(input) {
  input.freezeManifest.documentSha256 = digest(input.document);
  const { manifestSha256, ...body } = input.freezeManifest;
  input.freezeManifest.manifestSha256 = digest(body);
  return input;
}
test("page images resolve only from frozen ownership, share one asset and ignore deployment overrides", () => {
  const input = fixture();
  const result = dashboardFrozenRasterInput(input, { ...configuration, pageAssets: { main: { image: "evil" } } });
  assert.deepEqual({ ...result.pageAssets }, { main: { image: "image" }, second: { image: "image" } });
  assert.equal(Object.keys(result.assets).length, 1);
  result.assets.image.bytes[0] = 99;
  assert.equal(input.resources.image[0], 1);
});
test("rejects unknown, mismatched, duplicate and font page bindings", () => {
  for (const mutation of [
    input => { input.freezeManifest.resources[0].pageIds = ["missing"]; },
    input => { input.document.application.pages[0].appearance.backgroundImageUrl = "https://remote/image"; },
    input => { input.freezeManifest.resources[0].pageIds = ["main", "main"]; },
    input => { Object.assign(input.freezeManifest.resources[0], { kind: "font", mime: "font/ttf", faceIndex: 0, licenseEvidence: "test" }); },
  ]) {
    const input = fixture(); mutation(input);
    assert.throws(() => dashboardFrozenRasterInput(seal(input), configuration), /page/);
  }
});
test("node-only manifests do not acquire a new page binding field", () => {
  const input = fixture(); input.freezeManifest.resources = []; input.resources = {};
  assert.equal(Object.hasOwn(dashboardFrozenRasterInput(seal(input), configuration), "pageAssets"), false);
});
