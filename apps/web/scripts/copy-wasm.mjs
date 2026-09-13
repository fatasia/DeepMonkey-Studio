import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const destination = join(here, "..", "public", "wasm");
const dracoDestination = join(here, "..", "public", "draco");
let current = dirname(require.resolve("web-ifc"));
while (!existsSync(join(current, "web-ifc.wasm")) && dirname(current) !== current) current = dirname(current);
if (!existsSync(join(current, "web-ifc.wasm"))) throw new Error("找不到 web-ifc.wasm，请先运行 pnpm install");
mkdirSync(destination, { recursive: true });
for (const name of ["web-ifc.wasm", "web-ifc-mt.wasm"]) {
  const source = join(current, name);
  if (existsSync(source)) copyFileSync(source, join(destination, name));
}

const dracoSource = join(dirname(require.resolve("three")), "..", "examples", "jsm", "libs", "draco", "gltf");
const dracoFiles = ["draco_decoder.wasm", "draco_wasm_wrapper.js"];
if (!dracoFiles.every((name) => existsSync(join(dracoSource, name)))) {
  throw new Error("找不到 Three.js Draco 解码器，请先运行 pnpm install");
}
mkdirSync(dracoDestination, { recursive: true });
for (const name of dracoFiles) copyFileSync(join(dracoSource, name), join(dracoDestination, name));

const dracoGltfSource = dirname(require.resolve("draco3dgltf"));
const dracoGltfFiles = ["draco_decoder_gltf.wasm", "draco_encoder.wasm"];
if (!dracoGltfFiles.every((name) => existsSync(join(dracoGltfSource, name)))) {
  throw new Error("找不到 glTF-Transform 所需的 Draco 编解码器，请先运行 pnpm install");
}
for (const name of dracoGltfFiles) copyFileSync(join(dracoGltfSource, name), join(dracoDestination, name));

const basisDestination = join(here, "..", "public", "basis");
const basisVendor = join(here, "..", "vendor", "basis");
const provenance = JSON.parse(readFileSync(join(basisVendor, "provenance.json"), "utf8"));
mkdirSync(basisDestination, { recursive: true });
for (const [name, expected] of Object.entries(provenance.files)) {
  const bytes = readFileSync(join(basisVendor, name));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Basis encoder checksum mismatch: ${name}`);
  writeFileSync(join(basisDestination, name === "basis_encoder.js" ? "basis_encoder.mjs" : name), name === "basis_encoder.js" ? `${bytes.toString("utf8")}\nexport default BASIS;\n` : bytes);
}
const basisSource = join(dirname(require.resolve("three")), "..", "examples", "jsm", "libs", "basis");
for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) copyFileSync(join(basisSource, name), join(basisDestination, name));
copyFileSync(join(basisVendor, "provenance.json"), join(basisDestination, "provenance.json"));
console.log(`[copy-wasm] web-ifc -> ${destination}; draco -> ${dracoDestination}; basis -> ${basisDestination}`);
