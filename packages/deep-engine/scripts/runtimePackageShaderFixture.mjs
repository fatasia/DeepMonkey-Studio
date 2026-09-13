import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackageLodInput } from "./runtimePackageLodFixture.mjs";

/** Self-authored LOD silhouettes, mixed built-in/DeepSL materials and all five texture slots. */
export function createRuntimePackageShaderInput(api) {
  const input = createRuntimePackageLodInput(), packet = input.renderPacket.value;
  input.packageId = "deep.runtime.shader.golden";
  for (const geometry of packet.geometries) {
    geometry.uv1 = geometry.uv0.slice();
    geometry.tangents = new Float32Array(Array.from({ length: geometry.vertices.length / 6 }, () => [1, 0, 0, 1]).flat());
  }
  const texture = (id, semantic, pixels) => ({ id, revision: 1, semantic, width: 2, height: 2,
    data: new Uint8Array(pixels), sampler: { magFilter: "nearest", minFilter: "nearest" } });
  packet.textures.push(
    texture("shader.mr", "metallicRoughness", Array(4).fill([255, 180, 120, 255]).flat()),
    texture("shader.normal", "normal", [128, 128, 255, 255, 165, 128, 250, 255, 128, 160, 250, 255, 128, 128, 255, 255]),
    texture("shader.ao", "occlusion", [90, 90, 90, 255, 255, 255, 255, 255, 170, 170, 170, 255, 220, 220, 220, 255]),
    texture("shader.emissive", "emissive", Array(4).fill([190, 90, 25, 255]).flat()),
  );
  input.shaderPackages = []; input.materialBindings = [];
  const definitions = [
    { id: "shader.opaque", mode: "opaque", color: [0.08, 0.65, 0.25, 1], double: false },
    { id: "mask", mode: "mask", color: [0.85, 0.5, 0.05, 1], double: false },
    { id: "blend.near", mode: "blend", color: [0.1, 0.25, 0.9, 0.4], double: true },
  ];
  for (const value of definitions) {
    const source = `shader deep.runtime.${value.mode} {
      surface standard;
      baseColor [${value.color.join(", ")}];
      metallic 0.35;
      roughness 0.45;
      alpha ${value.mode};
      doubleSided ${value.double};
      baseColorTexture on;
      metallicRoughnessTexture on;
      normalTexture on;
      occlusionTexture on;
      emissiveTexture on;
      baseColorTextureTransform texCoord 1 offset [0, 0] scale [1, 1] rotation 0;
      normalScale -0.5;
      occlusionStrength 0.6;
      emissiveFactor [0.02, 0.04, 0.01];
      emissiveStrength 3.5;
    }`;
    const compiled = api.adaptDeepSlStandardToShaderPackage({ schemaVersion: 1, source,
      packageId: `deep.runtime.${value.mode}`, packageVersion: "1.0.0", compilerVersion: "1.0.0",
      targetAbi: "deep.pbr.mesh.v2", capabilities: { features: [],
        limits: { maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 } } });
    assert.equal(compiled.success, true, JSON.stringify(compiled.report.issues));
    const authored = api.createRuntimeDeepSlMaterial(value.id, compiled, { baseColor: "mask.grid",
      metallicRoughness: "shader.mr", normal: "shader.normal", occlusion: "shader.ao", emissive: "shader.emissive" });
    const index = packet.materials.findIndex(material => material.id === value.id);
    if (index < 0) packet.materials.push(authored.material); else packet.materials[index] = authored.material;
    input.materialBindings.push(authored.binding);
    input.shaderPackages.push({ revision: 1, value: compiled.package });
  }
  for (const instance of packet.instances) {
    if (["opaque.fallback", "opaque.far", "opaque.affine"].includes(instance.id)) instance.material = "shader.opaque";
  }
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = "--check", ...extra] = process.argv.slice(2);
  assert(["--write", "--check"].includes(mode) && !extra.length,
    "Usage: node scripts/runtimePackageShaderFixture.mjs [--write|--check]");
  const { build } = await import("esbuild");
  const bundled = await build({ stdin: { contents: `export * from './src/runtimePackage/index.ts';
    export { adaptDeepSlStandardToShaderPackage } from './src/shaderAuthoring/packageAdapter.ts';`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "esm", target: "node22" });
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const runtime = api.buildDeepRuntimePackage(createRuntimePackageShaderInput(api));
  const bytes = `${api.serializeDeepRuntimePackage(runtime)}\n`;
  const file = new URL("../../deep-engine-native/tests/fixtures/runtime-package-shader-v2.json", import.meta.url);
  if (mode === "--write") await writeFile(file, bytes, "utf8");
  else assert.equal(await readFile(file, "utf8"), bytes, "Shader runtime golden differs from the TypeScript builder.");
  assert.equal(api.parseDeepRuntimePackage(bytes).valid, true);
  console.log(JSON.stringify({ passed: true, mode, file: fileURLToPath(file), packageHash: runtime.packageHash.value,
    shaderPackages: runtime.entrypoints.shaderPackages.length, materialBindings: runtime.materialBindings.length }));
}
