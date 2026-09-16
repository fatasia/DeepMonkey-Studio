import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackageLodInput } from "./runtimePackageLodFixture.mjs";

export function createRuntimeIblFixture() {
  const data = (texels, rgb) => {
    const bytes = Buffer.alloc(texels * 8);
    for (let pixel = 0; pixel < texels; pixel++) {
      [...rgb, 0x3c00].forEach((half, channel) => bytes.writeUInt16LE(half, pixel * 8 + channel * 2));
    }
    return bytes.toString("base64");
  };
  return { schema: "deep-engine.ibl-prefiltered", schemaVersion: 1, id: "environment.prefiltered.golden", revision: 1,
    kind: "prefiltered-hdri", format: "rgba16float", encoding: "base64-le", faceOrder: "px-nx-py-ny-pz-nz",
    source: { contentHash: { algorithm: "sha256", value: "0".repeat(64) }, license: "CC0-1.0" },
    specular: { mips: [{ size: 2, dataBase64: data(24, [0x3800, 0x3400, 0x3000]) },
      { size: 1, dataBase64: data(6, [0x3400, 0x3000, 0x2c00]) }] },
    diffuse: { mips: [{ size: 1, dataBase64: data(6, [0x3c00, 0x3800, 0x3400]) }] },
    brdfLut: { width: 1, height: 1, dataBase64: data(1, [0x3800, 0x3400, 0]) } };
}
export function createRuntimePackageIblInput() {
  return { ...createRuntimePackageLodInput(), packageId: "deep.runtime.ibl.golden", environment: createRuntimeIblFixture() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = "--check", ...extra] = process.argv.slice(2);
  assert(["--write", "--check"].includes(mode) && !extra.length);
  const { build } = await import("esbuild");
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/runtimePackage/index.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22" });
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const runtime = api.buildDeepRuntimePackage(createRuntimePackageIblInput());
  const bytes = `${api.serializeDeepRuntimePackage(runtime)}\n`;
  const file = new URL("../../deep-engine-native/tests/fixtures/runtime-package-prefiltered-ibl-v1.json", import.meta.url);
  if (mode === "--write") await writeFile(file, bytes, "utf8");
  else assert.equal(await readFile(file, "utf8"), bytes);
  assert.equal(api.parseDeepRuntimePackage(bytes).valid, true);
  console.log(JSON.stringify({ passed: true, mode, packageHash: runtime.packageHash.value }));
}
