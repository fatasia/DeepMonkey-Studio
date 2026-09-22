import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboardLayoutCaptureCache } from "./dashboardLayoutCaptureCache.mjs";
const request = () => ({ nodeId: "kpi", logicalSize: [160, 100], data: { metric: { value: 3 } },
  locale: "zh-CN", fonts: [{ id: "f", faceIndex: 0, bytes: Uint8Array.of(1, 2) }] });
test("binds all request fields and actual font bytes; neither input nor output aliases stored data", () => {
  const cache = createDashboardLayoutCaptureCache({ executableSha256: "a" }), req = request();
  const value = { layout: { textBoxes: [{ text: "3" }] } }; cache.put(req, value);
  value.layout.textBoxes[0].text = "mutated";
  assert.equal(cache.get(req).layout.textBoxes[0].text, "3");
  const returned = cache.get(req); returned.layout.textBoxes.length = 0;
  assert.equal(cache.get(req).layout.textBoxes.length, 1);
  for (const mutate of [r => r.fonts[0].bytes[0]++, r => r.locale = "en-US", r => r.logicalSize[0]++, r => r.data.metric.value++]) {
    const next = request(); mutate(next); assert.equal(cache.get(next), undefined);
  }
});
test("enforces LRU/byte bounds and cancellation on hits and insertion", () => {
  const cache = createDashboardLayoutCaptureCache({}, { maxEntries: 1, maxBytes: 64 });
  const a = request(), b = { ...request(), nodeId: "b" };
  cache.put(a, { layout: [] }); cache.put(b, { layout: [] });
  assert.equal(cache.get(a), undefined); assert.equal(cache.stats().entries, 1);
  cache.put(a, { tooLarge: "x".repeat(100) }); assert.equal(cache.get(a), undefined);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => cache.get(b, controller.signal)); assert.throws(() => cache.put(a, {}, controller.signal));
});
