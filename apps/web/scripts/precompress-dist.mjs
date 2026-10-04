import { brotliCompressSync, constants } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

// 为 dist 生成 brotli-11 预压缩 sidecar（<file>.br），配合 API 端 productionWeb.ts 的
// @fastify/static preCompressed 选项按 Accept-Encoding 协商直传。这是"体积极致"批次
// 的传输层主刀：参数化 CAD 内核 replicad_single.wasm 21.9MiB → 4.8MiB（-78%），
// 全部可压缩产物合计约砍 80%。磁盘上多一份 sidecar（桌面安装器内嵌 +~1.3%，可忽略），
// 换服务端部署零运行时压缩成本、传输体积一次到位。
//
// 用法：构建链自动执行（package.json build 末位）；也可手动 `node scripts/precompress-dist.mjs`。
// 环境变量：PRECOMPRESS_QUALITY 覆盖质量档（默认 11，开发迭代可降为 5 加速）。

const distRoot = join(import.meta.dirname, "..", "dist");
const quality = Number(process.env.PRECOMPRESS_QUALITY ?? 11);
const compressible = new Set([".html", ".js", ".mjs", ".cjs", ".css", ".json", ".svg", ".txt", ".xml", ".wasm", ".ttf"]);
const minimumBytes = 1024;

const rows = [];
collect(distRoot);
if (rows.length === 0) throw new Error(`dist 不存在或没有可压缩产物：${distRoot}（请先执行 vite build）`);

let rawTotal = 0;
let brTotal = 0;
let elapsed = Date.now();
for (const row of rows) {
  const source = readFileSync(row.path);
  const compressed = brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
      [constants.BROTLI_PARAM_LGWIN]: 24,
    },
  });
  writeFileSync(`${row.path}.br`, compressed);
  rawTotal += source.byteLength;
  brTotal += compressed.byteLength;
}
elapsed = Date.now() - elapsed;

// 体量门:预压缩收益退化即失败(防止脚本被绕过/参数被调坏后带病交付)。
// 参数化 CAD 内核 sidecar 必须存在且 ≤6MiB;可压缩面整体传输比不得超过 30%(实测 ≈23%)。
const cadSidecar = rows.find((row) => /replicad_single.*\.wasm$/.test(row.relative));
if (!cadSidecar) throw new Error("[precompress] 体量门:未找到参数化 CAD wasm,产物不完整");
const cadSidecarBytes = statSync(`${cadSidecar.path}.br`).size;
if (cadSidecarBytes > 6 * 1048576) throw new Error(`[precompress] 体量门:CAD wasm brotli 超预算 ${format(cadSidecarBytes)} > 6.0MiB`);
const transferRatio = brTotal / rawTotal;
if (transferRatio > 0.3) throw new Error(`[precompress] 体量门:可压缩面传输比 ${(transferRatio * 100).toFixed(1)}% > 30%`);

const top = [...rows]
  .map((row, index) => ({ name: row.relative, raw: statSync(row.path).size, br: statSync(`${row.path}.br`).size }))
  .sort((a, b) => b.raw - a.raw)
  .slice(0, 8);
for (const { name, raw, br } of top) {
  console.log(`[precompress] ${name.padEnd(52)} ${format(raw)} -> ${format(br)} (${((1 - br / raw) * 100).toFixed(0)}%)`);
}
console.log(
  `[precompress] ${rows.length} 个产物预压缩完成（quality=${quality}，${(elapsed / 1000).toFixed(0)}s）：` +
    `${format(rawTotal)} -> ${format(brTotal)}，传输体积砍掉 ${((1 - brTotal / rawTotal) * 100).toFixed(0)}%`,
);

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(entryPath);
      continue;
    }
    if (!compressible.has(extname(entry.name))) continue;
    if (entry.name.endsWith(".br")) continue;
    if (statSync(entryPath).size < minimumBytes) continue;
    rows.push({ path: entryPath, relative: relPath(entryPath) });
  }
}

function relPath(path) {
  return path.slice(distRoot.length + 1);
}

function format(value) {
  return value >= 1048576 ? `${(value / 1048576).toFixed(2)}MiB` : `${(value / 1024).toFixed(1)}KiB`;
}
