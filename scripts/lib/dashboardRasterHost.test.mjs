import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createDashboardRasterHost, rasterizeFrozenImage } from "./dashboardRasterHost.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function request(fit, options = {}) {
  const bytes = await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
    .png().toBuffer();
  return { width: 4, height: 4, fit, requestHash: "a".repeat(64),
    asset: { bytes, sha256: hash(bytes), mime: "image/png", identity: { id: "image", revision: 1 } }, ...options };
}
test("cover and fill render full extent preserving straight alpha", async () => {
  for (const fit of ["cover", "fill"]) {
    const result = await rasterizeFrozenImage(await request(fit));
    assert.equal(result.width, 4); assert.equal(result.height, 4);
    assert.equal(hash(result.rgba), result.sha256);
    for (let i = 0; i < result.rgba.length; i += 4) {
      assert.equal(result.rgba[i], 255); assert.equal(result.rgba[i + 3], 128);
    }
  }
});
test("contain adds transparent letterbox pixels", async () => {
  const result = await rasterizeFrozenImage(await request("contain"));
  assert.deepEqual([...result.rgba.slice(0, 16)], new Array(16).fill(0));
  assert.equal(result.rgba[16], 255); assert.equal(result.rgba[19], 128);
  assert.deepEqual([...result.rgba.slice(48)], new Array(16).fill(0));
});
test("cover crops the center while fill stretches the whole image", async () => {
  const pixels = Buffer.from([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]);
  const bytes = await sharp(pixels, { raw: { width: 4, height: 1, channels: 4 } }).png().toBuffer();
  const base = await request("cover", { width: 2, height: 2, asset: { bytes, sha256: hash(bytes), mime: "image/png" } });
  const cover = await rasterizeFrozenImage(base), fill = await rasterizeFrozenImage({ ...base, fit: "fill" });
  assert.notDeepEqual([...cover.rgba], [...fill.rgba]);
});
test("applies EXIF orientation before fitting", async () => {
  const pixels = Buffer.from([255,0,0, 255,0,0, 0,0,255, 0,0,255]);
  const bytes = await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).withMetadata({ orientation: 6 }).toBuffer();
  const output = await rasterizeFrozenImage(await request("fill", { width: 2, height: 2,
    asset: { bytes, sha256: hash(bytes), mime: "image/jpeg" } }));
  assert.ok(output.rgba[2] > output.rgba[0]);
  assert.ok(output.rgba[4] > output.rgba[6]);
});
test("rejects byte substitution and aborted work", async () => {
  const input = await request("fill"); input.asset.bytes[0] ^= 1;
  await assert.rejects(rasterizeFrozenImage(input), /hash/);
  await assert.rejects(rasterizeFrozenImage(await request("fill"), AbortSignal.abort()), /abort/i);
});
test("cancelled and invalid requests are rejected before structured cloning", async () => {
  const invalid = { width: 1, height: 1, cannotClone() {} };
  const signal = AbortSignal.abort(new Error("cancel before clone"));
  await assert.rejects(rasterizeFrozenImage(invalid, signal), /cancel before clone/);
  await assert.rejects(createDashboardRasterHost({ nativeExecutable: "missing", signal }).rasterizeText(invalid), /cancel before clone/);
  await assert.rejects(rasterizeFrozenImage({ ...invalid, width: 9000 }), /Invalid raster extent/);
});
test("aggregate font budget is checked before launching a producer or cloning", async () => {
  const bytes = new Uint8Array(32 * 1024 * 1024 + 1);
  const host = createDashboardRasterHost({ nativeExecutable: "missing" });
  await assert.rejects(host.rasterizeText({ width: 1, height: 1, fonts: [{ bytes }, { bytes }], cannotClone() {} }), /byte budget/);
});
test("image view never sends its backing buffer through structuredClone", async t => {
  const input = await request("fill");
  const backing = new Uint8Array(1024 * 1024);
  backing.set(input.asset.bytes, 64);
  input.asset.bytes = backing.subarray(64, 64 + input.asset.bytes.length);
  const clone = globalThis.structuredClone;
  t.mock.method(globalThis, "structuredClone", value => {
    assert.equal(value.asset, undefined);
    assert.equal(value.bytes, undefined);
    return clone(value);
  });
  const result = await rasterizeFrozenImage(input);
  assert.equal(result.rgba.length, 64);
});
