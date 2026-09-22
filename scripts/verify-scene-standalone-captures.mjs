import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sharp = createRequire(new URL("../apps/api/package.json", import.meta.url))("sharp");
const evidencePath = path.resolve(process.argv[2]), evidence = JSON.parse(await readFile(evidencePath, "utf8"));
const pixels = [];
for (const capture of [...(evidence.previews ?? []), ...evidence.captures]) {
  const match = /client=(\d+)x(\d+) dpi=\d+ clientOffset=(\d+),(\d+)/.exec(capture.captureLog);
  assert(match, "Capture requires measured client coordinates");
  const [width, height, left, top] = match.slice(1).map(Number);
  const bytes = await sharp(capture.png).extract({ left, top, width, height }).ensureAlpha().raw().toBuffer();
  const colors = new Set(), background = bytes.readUInt32LE((Math.floor(height * .1) * width + Math.floor(width * .1)) * 4);
  let foreground = 0, blue = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const rgba = bytes.readUInt32LE(index); colors.add(rgba);
    assert.equal(bytes[index + 3], 255);
    if (rgba !== background) foreground++;
    if (bytes[index + 2] > 120 && bytes[index + 1] > bytes[index] && bytes[index + 2] > bytes[index + 1]) blue++;
  }
  // Frozen fixture has a central blue box, not a title-only or solid-color frame.
  const ratio = blue / (width * height);
  if (evidence.background) {
    const expected = [1,3,5].map(offset => parseInt(evidence.background.slice(offset, offset + 2), 16));
    const actual = [background & 255, (background >>> 8) & 255, (background >>> 16) & 255];
    assert(actual.every((value, i) => Math.abs(value - expected[i]) <= 1), `Authored background mismatch ${actual} vs ${expected}`);
  } else assert(ratio > .1 && ratio < .5, `Expected visible blue Box area: ${capture.label}, ${ratio}`);
  assert(colors.size > 3 && foreground > width * height * .1);
  pixels.push({ label: capture.label, file: capture.png, width, height, colors: colors.size,
    foregroundPixels: foreground, backgroundRgba: background, blueSubjectFraction: ratio, clientRgbaSha256: createHash("sha256").update(bytes).digest("hex") });
}
assert.equal(evidence.captures.length, 4);
if (evidence.background) assert.equal(evidence.previews.length, 2);
assert.equal(new Set(pixels.map(item => item.clientRgbaSha256)).size, 1);
const output = path.join(path.dirname(evidencePath), "pixel-evidence.json");
await writeFile(output, JSON.stringify({ fixture: "published blue Box", pixels, identicalClientPixels: true }, null, 2));
console.log(JSON.stringify({ output, pixels }));
