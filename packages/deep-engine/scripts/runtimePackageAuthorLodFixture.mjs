import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackageLodInput } from "./runtimePackageLodFixture.mjs";

/** Same real silhouettes as screen-space golden; includes empty and multi-level author selections. */
export function createRuntimePackageAuthorLodInput() {
  const source = createRuntimePackageLodInput();
  source.packageId = "deep.runtime.author-lod.golden";
  source.renderPacket.id = "scene.author-lod";
  const selections = [[0], [1], [2], [], [0, 2], [1], [2]];
  source.renderPacket.value.instances = source.renderPacket.value.instances.map((instance, index) => ({
    ...instance, lod: { strategy: "author-selected", revision: 4,
      levels: ["lod.high", "lod.middle", "lod.low"].map((geometry, level) => ({ geometry, distance: level * 10, hysteresis: .1 })),
      selectedLevels: selections[index] },
  }));
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = "--check", ...extra] = process.argv.slice(2);
  assert(["--write", "--check"].includes(mode) && !extra.length,
    "Usage: node scripts/runtimePackageAuthorLodFixture.mjs [--write|--check]");
  const { build } = await import("esbuild");
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/runtimePackage/index.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22" });
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const runtime = api.buildDeepRuntimePackage(createRuntimePackageAuthorLodInput());
  const bytes = `${api.serializeDeepRuntimePackage(runtime)}\n`;
  const file = new URL("../../deep-engine-native/tests/fixtures/runtime-package-author-lod-v1.json", import.meta.url);
  if (mode === "--write") await writeFile(file, bytes, "utf8");
  else assert.equal(await readFile(file, "utf8"), bytes, "Author-selected LOD golden differs from the TypeScript builder.");
  assert.equal(api.parseDeepRuntimePackage(bytes).valid, true);
  console.log(JSON.stringify({ passed: true, mode, file: fileURLToPath(file), packageHash: runtime.packageHash.value }));
}
