import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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

console.log(`[copy-wasm] web-ifc -> ${destination}; draco -> ${dracoDestination}`);
