import assert from "node:assert/strict";
import test from "node:test";
import { resolveSceneViewerProductName, createTauriOverlay } from "./scene-viewer-package-core.mjs";

test("Scene viewer uses the product default unless --product-name is explicit", () => {
  for (const value of [undefined, "", "  "]) assert.equal(resolveSceneViewerProductName(value), "Deep Monkey Studio");
  assert.equal(resolveSceneViewerProductName("客户三维客户端"), "客户三维客户端");
  const overlay = createTauriOverlay({ productName: resolveSceneViewerProductName(), identifier: "com.test.viewer", version: "1.0.0", frontendDist: "../fixture" });
  assert.equal(overlay.productName, "Deep Monkey Studio");
  assert.equal(overlay.app.windows[0].title, "Deep Monkey Studio");
});
