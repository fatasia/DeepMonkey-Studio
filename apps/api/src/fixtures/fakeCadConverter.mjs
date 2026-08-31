import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";

const options = Object.fromEntries(process.argv.slice(2).reduce((entries, item, index, values) => {
  if (!item.startsWith("--")) return entries;
  entries.push([item.slice(2), values[index + 1] ?? ""]);
  return entries;
}, []));

if (!options.input || !options.output) throw new Error("missing --input or --output");
await mkdir(options.output, { recursive: true });
const source = await readFile(options.input);
if (options["invalid-geometry"] === "true") {
  await writeFile(path.join(options.output, "geometry.glb"), source);
} else {
  const document = new Document();
  const buffer = document.createBuffer("fixture");
  const positions = document.createAccessor("positions").setType(Accessor.Type.VEC3).setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const indices = document.createAccessor("indices").setType(Accessor.Type.SCALAR).setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]));
  const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
  const mesh = document.createMesh("Fixture triangle").addPrimitive(primitive);
  document.createScene("Fixture").addChild(document.createNode("Fixture").setMesh(mesh));
  await writeFile(path.join(options.output, "geometry.glb"), await new NodeIO().writeBinary(document));
}
await writeFile(path.join(options.output, "hierarchy.json"), JSON.stringify({ nodes: [{ id: "root", name: "Assembly" }] }));
await writeFile(path.join(options.output, "properties.json"), JSON.stringify({ sourceFormat: options.format }));
if (options["include-pmi"] !== "false") {
  await writeFile(path.join(options.output, "pmi.json"), JSON.stringify({ annotations: [] }));
}
