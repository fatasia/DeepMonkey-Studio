import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDashboardTextRasterCache } from "./dashboardTextRasterCache.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const native = "a".repeat(64);
function fixture() {
  const bytes = Uint8Array.of(1, 2), rgba = Uint8Array.of(1, 2, 3, 255), sha256 = hash(rgba);
  const request = { width: 1, height: 1, fontSize: 12, lineHeight: 18, text: "字", requestHash: "b".repeat(64),
    fonts: [{ bytes, sha256: hash(bytes), faceIndex: 0 }] };
  const result = { width: 1, height: 1, rgba, sha256, requestHash: request.requestHash, sourceSha256: "c".repeat(64),
    producerEvidence: { executableSha256: native, pixelSha256: sha256, sourceSha256: "c".repeat(64) },
    lines: [{ baseline: 10 }], usedFaces: [{ family: "Frozen" }] };
  return { request, result };
}
test("returns independent pixels, placements and face metadata on each hit", () => {
  const { request, result } = fixture(), cache = createDashboardTextRasterCache(native);
  cache.put(request, result); result.rgba[0] = 200; result.lines[0].baseline = 100;
  const first = cache.get(request); assert.equal(first.rgba[0], 1); assert.equal(first.lines[0].baseline, 10);
  first.rgba[0] = 222; first.usedFaces[0].family = "Changed";
  assert.equal(cache.get(request).rgba[0], 1); assert.equal(cache.get(request).usedFaces[0].family, "Frozen");
});
test("keys full metrics, text, request identity and actual frozen font bytes", () => {
  const { request, result } = fixture(), cache = createDashboardTextRasterCache(native); cache.put(request, result);
  for (const changed of [{ fontSize: 13 }, { lineHeight: 20 }, { width: 2 }, { text: "文" }, { requestHash: "d".repeat(64) }])
    assert.equal(cache.get({ ...request, ...changed }), undefined);
  const altered = structuredClone(request); altered.fonts[0].bytes[0] = 4;
  assert.throws(() => cache.get(altered), /font hash/);
  altered.fonts[0].sha256 = hash(altered.fonts[0].bytes); assert.equal(cache.get(altered), undefined);
});
test("abort wins over a populated hit and prevents insertion", () => {
  const { request, result } = fixture(), cache = createDashboardTextRasterCache(native); cache.put(request, result);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  assert.throws(() => cache.get(request, controller.signal), /cancelled/);
  assert.throws(() => cache.put(request, result, controller.signal), /cancelled/);
});
test("refuses pixel, receipt and executable identity tampering", () => {
  for (const mutate of [value => value.rgba[0]++, value => value.producerEvidence.executableSha256 = "e".repeat(64),
    value => value.producerEvidence.pixelSha256 = "e".repeat(64), value => value.requestHash = "e".repeat(64)]) {
    const { request, result } = fixture(), cache = createDashboardTextRasterCache(native); mutate(result);
    assert.throws(() => cache.put(request, result), /receipt or pixels/); assert.equal(cache.stats().entries, 0);
  }
});
test("enforces byte and entry budgets with least-recently-used eviction", () => {
  const { request, result } = fixture(), cache = createDashboardTextRasterCache(native, { maxEntries: 1, maxBytes: 4096 });
  cache.put(request, result); cache.put({ ...request, text: "次" }, result);
  assert.equal(cache.get(request), undefined); assert.equal(cache.stats().entries, 1); assert(cache.stats().bytes <= 4096);
  const small = createDashboardTextRasterCache(native, { maxBytes: 1 }); small.put(request, result);
  assert.equal(small.stats().entries, 0);
  assert.throws(() => createDashboardTextRasterCache(native, { maxEntries: 129 }), /budget/);
});
