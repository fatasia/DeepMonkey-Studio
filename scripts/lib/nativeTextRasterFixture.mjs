// Real child-process wire fixture; it does not perform Native font rendering.
import { readFileSync, writeFileSync, openSync, ftruncateSync, closeSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
if (args[0] !== "--rasterize-text" || args[2] !== "--output" || args.length !== 4) process.exit(9);
const source = readFileSync(args[1]), input = JSON.parse(source), mode = process.env.TEXT_FIXTURE_MODE;
if (mode === "timeout") setInterval(() => {}, 1000);
else if (mode === "failure") { process.stderr.write("fixture exit failure"); process.exitCode = 7; }
else if (mode === "diagnostic") { process.stderr.write("x".repeat(64 * 1024)); setInterval(() => {}, 1000); }
else if (mode === "missing") { /* successful exit without output */ }
else if (mode === "oversized") { const f = openSync(args[3], "wx"); ftruncateSync(f, 33 * 1024 * 1024); closeSync(f); }
else if (mode === "utf8") writeFileSync(args[3], Buffer.from([0xff]));
else {
  const rgba = Buffer.alloc(input.request.width * input.request.height * 4, 255);
  const value = { schema: "deep-engine.text-raster-result", schemaVersion: 1,
    producer: "cosmic-text-0.19.0-frozen-v1", sourceSha256: hash(source), width: input.request.width, height: input.request.height,
    rgbaBase64: rgba.toString("base64"), pixelSha256: hash(rgba), format: "rgba8unorm-srgb", alphaMode: "straight",
    glyphCount: 1, lineCount: 1, layoutWidth: 2, layoutHeight: 2, inkBounds: [0, 0, input.request.width, input.request.height], clipped: false,
    lines: [{ lineIndex: 0, baseline: 1, top: 0, height: 2, width: 2 }],
    usedFaces: [{ sha256: input.fonts[0].sha256, faceIndex: input.fonts[0].faceIndex, family: "Fixture", postScriptName: "Fixture-Regular", weight: 400, style: "normal" }] };
  if (mode === "source") value.sourceSha256 = "0".repeat(64);
  if (mode === "pixels") value.pixelSha256 = "0".repeat(64);
  if (mode === "dimensions") value.width++;
  if (mode === "unfrozen") value.usedFaces[0].sha256 = "0".repeat(64);
  if (mode === "forgedstyle") value.usedFaces[0].style = "italic";
  if (mode === "forgedweight") value.usedFaces[0].weight = 700;
  if (mode === "base64") value.rgbaBase64 = "AB==";
  if (mode === "lines") value.lineCount++;
  if (mode === "ink") value.inkBounds = [1, 0, 0, 2];
  if (mode === "unknown") value.extra = true;
  if (mode === "empty") { value.glyphCount = 0; value.usedFaces = []; value.inkBounds = null; }
  if (mode === "request-tamper") { chmodSync(args[1], 0o600); writeFileSync(args[1], "{}"); }
  if (mode === "wrapped") { value.lines.push({ ...value.lines[0], baseline: 3, top: 2 }); value.lineCount++; }
  writeFileSync(args[3], JSON.stringify(value));
}
