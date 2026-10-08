import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

// 生产 dist 剔除 public/dev 开发试验页(engine.html / wasm-bench.html / dev/pkg bench wasm)。
// 这些页面只被本地 e2e 门禁经 vite dev server(5173/5177)消费——dev server 直接服务 public/ 源,
// 与 dist 无关;生产代码唯一引擎 wasm 路径是 /engine-wasm/(StudioDeepWasmBridge)。
// 不剔除时:dist 白带 ~5.8MiB raw(~1.4MiB brotli sidecar),生产用户永不可达。
// 用法:构建链 vite build 之后、precompress 之前执行(package.json build);dist 不存在时跳过。

const dist = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "dist"));
const target = resolve(dist, "dev");
if (relative(dist, target) !== 'dev') throw new Error('Development prune target must stay within build output');
if (!existsSync(target)) {
  console.log("[prune-dist-dev] dist/dev 不存在,跳过");
  process.exit(0);
}
const bytes = (path) => {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? bytes(child) : statSync(child).size;
  }
  return total;
};
const freed = bytes(target);
rmSync(target, { recursive: true, force: true });
console.log(`[prune-dist-dev] 已剔除 dist/dev(开发试验页,生产不可达): ${(freed / 1048576).toFixed(2)} MiB`);
