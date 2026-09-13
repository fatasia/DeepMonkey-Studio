import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Shared author input: distinct 4/2/1-triangle silhouettes, with UVs at every level.
export function createRuntimePackageLodInput() {
  const geometry = (id, points, indices) => ({ id, revision: 1,
    vertices: new Float32Array(points.flatMap(([x, y]) => [x, y, 0, 0, 0, 1])),
    indices: new Uint32Array(indices), uv0: new Float32Array(points.flatMap(([x, y]) => [(x + 1) / 2, (y + 1) / 2])),
  });
  const transform = (x, y, z, sx, sy = sx, shear = 0) => new Float32Array([
    sx, 0, 0, 0, shear, sy, 0, 0, 0, 0, Math.abs(sx), 0, x, y, z, 1,
  ]);
  const lod = () => ({ hysteresisRatio: 0.12, levels: [
    { geometry: "lod.high", minProjectedDiameterPixels: 180, geometricError: 0 },
    { geometry: "lod.middle", minProjectedDiameterPixels: 80, geometricError: 0.125, resident: false },
    { geometry: "lod.low", minProjectedDiameterPixels: 0, geometricError: 0.375 },
  ] });
  const instance = (id, material, matrix) => ({ id, geometry: "lod.high", material, transform: matrix, lod: lod() });
  const material = (id, baseColor, extra = {}) => ({ id, baseColor, metallic: 0, roughness: 0.8, ...extra });
  return {
    packageId: "deep.runtime.lod.golden", packageVersion: "0.1.0",
    renderPacket: { id: "scene.lod", revision: 1, value: {
      geometries: [
        geometry("lod.high", [[-.8, -.65], [.8, -.65], [.8, .65], [-.8, .65], [0, 0]], [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
        geometry("lod.middle", [[0, -.7], [.7, 0], [0, .7], [-.7, 0]], [0, 1, 2, 0, 2, 3]),
        geometry("lod.low", [[-.75, -.6], [.75, -.6], [0, .7]], [0, 1, 2]),
      ],
      materials: [
        material("opaque", [.08, .65, .25]),
        material("mask", [.85, .5, .05], { alphaMode: "MASK", alphaCutoff: 0.5,
          baseColorTexture: { texture: "mask.grid" } }),
        material("blend.near", [.1, .25, .9], { alphaMode: "BLEND", baseColorAlpha: 0.4 }),
        material("blend.far", [.9, .15, .1], { alphaMode: "BLEND", baseColorAlpha: 0.55 }),
      ],
      instances: [
        instance("opaque.near", "opaque", transform(-1.1, .75, .75, .72)),
        instance("opaque.fallback", "opaque", transform(0, .75, -.8, .34)),
        instance("opaque.far", "opaque", transform(1.1, .75, -2, .2)),
        instance("opaque.affine", "opaque", transform(-1.1, -.75, 0, .35, .62, .28)),
        instance("mask.mirrored", "mask", transform(1.1, -.75, .2, -.55, .55)),
        // Deliberately near-first: exporters must preserve author order; renderers own depth sorting.
        instance("blend.near", "blend.near", transform(0, -.75, .35, .38)),
        instance("blend.far", "blend.far", transform(0, -.75, -.55, .5)),
      ],
      textures: [{ id: "mask.grid", revision: 1, semantic: "baseColor", width: 2, height: 2,
        data: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]),
        sampler: { magFilter: "nearest", minFilter: "nearest" } }],
    } },
  };
}

// Bundles source in memory: regenerating this fixture never cleans/rebuilds the engine or Lab.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = "--check", ...extra] = process.argv.slice(2);
  assert(["--write", "--check"].includes(mode) && !extra.length,
    "Usage: node scripts/runtimePackageLodFixture.mjs [--write|--check]");
  const { build } = await import("esbuild");
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/runtimePackage/index.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22" });
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const runtime = api.buildDeepRuntimePackage(createRuntimePackageLodInput());
  const bytes = `${api.serializeDeepRuntimePackage(runtime)}\n`;
  const file = new URL("../../deep-engine-native/tests/fixtures/runtime-package-lod-v1.json", import.meta.url);
  if (mode === "--write") await writeFile(file, bytes, "utf8");
  else assert.equal(await readFile(file, "utf8"), bytes, "LOD golden differs from the TypeScript builder.");
  assert.equal(api.parseDeepRuntimePackage(bytes).valid, true);
  console.log(JSON.stringify({ passed: true, mode, file: fileURLToPath(file), packageHash: runtime.packageHash.value }));
}
