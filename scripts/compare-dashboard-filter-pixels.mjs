import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
const [baselineArg, candidateArg, outputArg] = process.argv.slice(2);
assert(baselineArg && candidateArg && outputArg, "Expected baseline, candidate and output JSON");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const baseline = path.resolve(baselineArg), candidate = path.resolve(candidateArg);
const before = JSON.parse(await readFile(path.join(baseline, "evidence.json"), "utf8"));
const after = JSON.parse(await readFile(path.join(candidate, "evidence.json"), "utf8"));
assert.equal(before.packageSha256, after.packageSha256, "Comparisons require identical runtime packages");
const captures = [];
for (const option of [1, 2]) {
  const inputs = [baseline, candidate].map(directory => path.join(directory, `option-${option}.png`));
  const pixels = await Promise.all(inputs.map(async input => {
    const bytes = await readFile(input);
    const value = await sharp(bytes).extract({ left: 9, top: 38, width: 960, height: 540 }).ensureAlpha().raw().toBuffer();
    return { bytes, value };
  }));
  assert(pixels[0].value.equals(pixels[1].value), `Option ${option}: client pixels differ`);
  captures.push({ option, inputs, imageHashes: pixels.map(value => sha(value.bytes)),
    clientPixelSha256: sha(pixels[0].value), comparedBytes: pixels[0].value.length, changedBytes: 0 });
}
await writeFile(path.resolve(outputArg), JSON.stringify({ scope: "Entire 960x540 client rectangle; excludes OS window chrome only",
  packageSha256: before.packageSha256, baselineExecutable: before.executableSha256,
  candidateExecutable: after.executableSha256, captures }, null, 2));
console.log(`Client pixel equivalence passed: ${captures.length}/2`);
