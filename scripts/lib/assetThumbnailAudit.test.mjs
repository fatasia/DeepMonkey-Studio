import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { normalizeAssetThumbnail } from "./assetThumbnailAudit.mjs";

test("centers a small transparent subject on a consistent 4:3 canvas", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-thumbnail-"));
  try {
    const source = path.join(root, "source.png");
    const target = path.join(root, "normalized", "target.png");
    await sharp({ create: { width: 482, height: 360, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from(`<svg width="120" height="46"><rect width="120" height="46" fill="#42a5f5"/></svg>`), left: 38, top: 44 }])
      .png()
      .toFile(source);

    const result = await normalizeAssetThumbnail(source, target);
    const metadata = await sharp(target).metadata();
    assert.equal(result.valid, true);
    assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 480, height: 360 });
    assert.ok(result.normalized.renderedWidth >= 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a source thumbnail that is too small for a commercial card", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-thumbnail-small-"));
  try {
    const source = path.join(root, "source.png");
    await sharp({ create: { width: 120, height: 90, channels: 4, background: "#335566" } }).png().toFile(source);
    const result = await normalizeAssetThumbnail(source, path.join(root, "target.png"));
    assert.equal(result.valid, false);
    assert.match(result.reason, /分辨率/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps an extremely slender preview out of the published catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-thumbnail-slender-"));
  try {
    const source = path.join(root, "source.png");
    const target = path.join(root, "target.png");
    await sharp({ create: { width: 482, height: 360, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from(`<svg width="38" height="330"><rect width="38" height="330" rx="12" fill="#b3453d"/></svg>`), left: 220, top: 15 }])
      .png()
      .toFile(source);

    const result = await normalizeAssetThumbnail(source, target);
    assert.equal(result.valid, false);
    assert.ok(result.normalized.shortSideRatio < 0.14);
    assert.match(result.reason, /短边占比/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
