import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const [oneArg, twoArg, outputArg] = process.argv.slice(2);
assert(oneArg && twoArg && outputArg, "Expected <1x package directory> <2x package directory> <output directory>");
const output = path.resolve(outputArg); await mkdir(output);
const evidence: unknown[] = [];
let frozenNativeSha256: string | undefined;
for (const [density, directory] of [[1, oneArg], [2, twoArg]] as const) {
  const base = path.resolve(directory), deployment = JSON.parse(await readFile(path.join(base, "deployment.json"), "utf8"));
  const nativeExecutableSha256 = createHash("sha256").update(await readFile(deployment.nativeExecutable)).digest("hex");
  frozenNativeSha256 ??= nativeExecutableSha256;
  assert.equal(nativeExecutableSha256, frozenNativeSha256, "Both densities require the same Native executable");
  const packagePath = path.join(base, "runtime-package.json"), bytes = await readFile(packagePath);
  const pkg = JSON.parse(bytes.toString()), atlases: unknown[] = [];
  for (const payload of Object.values(pkg.payloads) as any[]) for (const atlas of payload.atlases ?? []) {
    const pixels = Buffer.from(atlas.dataBase64, "base64");
    atlases.push({ id: atlas.id, width: atlas.width, height: atlas.height, bytes: pixels.length,
      sha256: createHash("sha256").update(pixels).digest("hex"), quads: payload.quads.filter((quad: any) => quad.atlasId === atlas.id) });
  }
  for (const round of [1, 2]) for (const effectiveScale of [1, 1.25, 1.5, 2]) {
    const label = `density-${density}-scale-${effectiveScale}-round-${round}`;
    const capture = await captureNativePlayerWindow({ label, executable: deployment.nativeExecutable,
      args: ["--package", packagePath], env: { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data") },
      outputDirectory: output, presentedMarker: "native package recovery checkpoint committed after present",
      clientSize: [960 * effectiveScale, 540 * effectiveScale], timeoutMs: 60_000 });
    assert.equal(createHash("sha256").update(await readFile(deployment.nativeExecutable)).digest("hex"), nativeExecutableSha256,
      "Native executable changed during density verification");
    const match = /client=(\d+)x(\d+) dpi=(\d+) clientOffset=(\d+),(\d+)/.exec(capture.captureLog);
    assert(match, capture.captureLog);
    assert.equal(Number(match[1]), 960 * effectiveScale); assert.equal(Number(match[2]), 540 * effectiveScale);
    const crops: Record<string, string> = {};
    // Source-pixel crops only; never resize images to claim sharper typography.
    for (const [name, rect] of Object.entries({ heading: [28, 24, 650, 42], kpi: [28, 108, 200, 110],
      chartHeading: [280, 115, 370, 42], axisSmall: [238, 90, 40, 418], table: [710, 100, 210, 390] })) {
      const crop = { left: Number(match[4]) + Math.floor(rect[0]! * effectiveScale),
        top: Number(match[5]) + Math.floor(rect[1]! * effectiveScale),
        width: Math.ceil(rect[2]! * effectiveScale), height: Math.ceil(rect[3]! * effectiveScale) };
      crops[name] = path.join(output, `${label}-${name}.png`);
      await sharp(capture.png).extract(crop).png().toFile(crops[name]!);
    }
    evidence.push({ density, effectiveScale, systemDpi: Number(match[3]), nativeExecutableSha256, round, capture, crops,
      packageSha256: createHash("sha256").update(bytes).digest("hex"), atlases,
      fonts: deployment.fontCatalog.fonts.map((font: any) => ({ id: font.id, sha256: font.sha256, faceIndex: font.faceIndex })) });
    await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ label, captureLog: capture.captureLog }));
  }
}
