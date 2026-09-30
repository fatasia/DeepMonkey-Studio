// I-C23 Native 刀 · 双端对拍 fixture 生成(esbuild 打包 lab 权威端 → 写 fixtures JSON)。
// 运行: node scripts/i-c23-native-layered-fixture.mjs
// 产物: packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const { build } = require(path.join(root, "packages/deep-engine/node_modules/esbuild"));
const outfile = path.join(root, "test-output/i-c23-native-layered/fixture-probe.mjs");
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(root, "packages/deep-engine/lab/iC23NativeLayeredFixture.ts")],
  outfile, bundle: true, format: "esm", platform: "node",
});
const { buildIC23NativeLayeredFixture } = await import(pathToFileURL(outfile).href);
const fixture = buildIC23NativeLayeredFixture();
if (fixture.block.length !== 76) throw Error(`block float count ${fixture.block.length} != 76`);
const target = path.join(root, "packages/deep-engine/fixtures/i-c23-native-layered-block-v1.json");
await writeFile(target, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${target} (${fixture.block.length} floats, ${fixture.blendCases.length} blend cases)`);
