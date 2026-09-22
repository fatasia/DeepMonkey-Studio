import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const requireWeb = createRequire(path.resolve(import.meta.dirname, "../../apps/web/package.json"));
const { NodeIO } = requireWeb("@gltf-transform/core");
const { getBounds } = requireWeb("@gltf-transform/functions");

const [sourceArg, outputArg, sidecarArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error("Usage: normalize-grounded-glb.mjs <source.glb> <output.glb> [sidecar.json]");
const sourcePath = path.resolve(sourceArg), outputPath = path.resolve(outputArg);
const source = await readFile(sourcePath);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const document = await new NodeIO().readBinary(source);
const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
if (!scene) throw new Error("GLB has no scene");
const bounds = getBounds(scene);
const positionAccessors = [...new Set(document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives().map((primitive) => primitive.getAttribute("POSITION")).filter((accessor) => accessor && accessor.getType() === "VEC3" && accessor.getComponentType() === 5126 && accessor.getArray())))];
const rawMinY = Math.min(...positionAccessors.flatMap((accessor) => {
  const values = accessor.getArray();
  return values ? Array.from({ length: values.length / 3 }, (_, index) => values[index * 3 + 1]) : [];
}));
const minY = rawMinY;
if (!Number.isFinite(minY) || !Number.isFinite(bounds.min[1])) throw new Error("GLB has no finite POSITION/world-space bounds");
if (Math.abs(minY) <= 0.001) throw new Error(`GLB is already grounded (minY=${minY})`);
for (const accessor of positionAccessors) {
  const values = accessor.getArray();
  if (!values) continue;
  const shifted = new Float32Array(values);
  for (let index = 1; index < shifted.length; index += 3) shifted[index] += -minY;
  accessor.setArray(shifted);
}
const minYAfter = Math.min(...positionAccessors.flatMap((accessor) => {
  const values = accessor.getArray();
  return values ? Array.from({ length: values.length / 3 }, (_, index) => values[index * 3 + 1]) : [];
}));
if (minYAfter < -0.001) throw new Error(`Grounding offset did not clear raw POSITION minY: ${minYAfter}`);
const output = Buffer.from(await new NodeIO().writeBinary(document));
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, output);
if (sidecarArg) {
  await writeFile(path.resolve(sidecarArg), `${JSON.stringify({ schemaVersion: 1, source: sourcePath, sourceSha256: sha256(source), output: outputPath, outputSha256: sha256(output), minYBefore: minY, minYAfter, worldMinYBefore: bounds.min[1], geometryOffsetY: -minY, policy: "explicit-grounding-offset; source bytes retained" }, null, 2)}\n`);
}
console.log(JSON.stringify({ sourceSha256: sha256(source), outputSha256: sha256(output), minYBefore: minY, minYAfter, offsetY: -minY, outputBytes: output.byteLength }));
