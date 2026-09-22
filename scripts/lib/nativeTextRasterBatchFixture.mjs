// Child-process transport fixture; pixels are synthetic, not font rendering evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const [command, source, flag, output] = process.argv.slice(2);
if (command !== "--rasterize-text-batch" || flag !== "--output") process.exit(9);
const input = JSON.parse(readFileSync(source)), mode = process.env.TEXT_FIXTURE_MODE;
if (mode === "timeout") setInterval(() => {}, 1000);
else {
  const shared = JSON.parse(input.shared);
  const results = input.requests.map(wire => {
    const request = JSON.parse(wire), rgba = Buffer.alloc(request.width * request.height * 4, 255);
    return { schema: "deep-engine.text-raster-result", schemaVersion: 1, producer: "cosmic-text-0.19.0-frozen-v1",
      sourceSha256: hash(`${input.shared.slice(0, -1)},"request":${wire}}`), width: request.width, height: request.height,
      rgbaBase64: rgba.toString("base64"), pixelSha256: hash(rgba), format: "rgba8unorm-srgb", alphaMode: "straight",
      glyphCount: 1, lineCount: 1, layoutWidth: 2, layoutHeight: 2, inkBounds: [0,0,request.width,request.height], clipped: false,
      lines: [{ lineIndex: 0, baseline: 1, top: 0, height: 2, width: 2 }],
      usedFaces: [{ sha256: shared.fonts[0].sha256, faceIndex: 0, family: "Fixture", postScriptName: "Fixture",
        weight: 400, style: "normal" }] };
  });
  if (mode === "missing") results.pop();
  if (mode === "reordered") results.reverse();
  if (mode === "pixels") results[1].pixelSha256 = "0".repeat(64);
  writeFileSync(output, JSON.stringify({ schema: "deep-engine.text-raster-batch-result", schemaVersion: 1, results }));
}
