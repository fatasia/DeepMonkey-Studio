#!/usr/bin/env node
/**
 * build-wasm-bundle.mjs — deep-engine-wasm 一键产物管线
 *
 *   cargo build(--profile <p>) → wasm-bindgen --target web → wasm-opt(可档位) → 拷贝到 apps/web/public/dev/pkg/ → 体积表
 *
 * 用法:
 *   node scripts/build-wasm-bundle.mjs [--profile wasm-release|release|debug] [--opt Oz|Os|O3|none]
 *        [--target wasm32-unknown-unknown] [--out-dir <dir>] [--no-install] [--no-opt] [--keep-going] [--json <file>]
 *
 * 默认:--profile wasm-release --opt Oz --target wasm32-unknown-unknown
 * 安装目录:apps/web/public/dev/pkg/(可用 --out-dir 覆盖;--no-install 只构建输出体积表不拷贝)
 *
 * 依赖:cargo、wasm-bindgen(~/.cargo/bin)、binaryen wasm-opt(定位规则同 scripts/wasm-optimize.mjs,
 *       约定 %USERPROFILE%/.cache/binaryen/binaryen-version_<n>/bin/wasm-opt.exe;缺失时 --opt 自动降级为 none 并告警)。
 */
import { spawnSync } from "node:child_process";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const has = (f) => argv.includes(f);

const repo = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const crateDir = join(repo, "packages", "deep-engine-wasm");
const profile = argOf("--profile") ?? "wasm-release";
const target = argOf("--target") ?? "wasm32-unknown-unknown";
let opt = argOf("--opt") ?? "Oz";
const outDir = argOf("--out-dir") ? resolve(argOf("--out-dir")) : join(repo, "apps", "web", "public", "dev", "pkg");
const noInstall = has("--no-install");
const keepGoing = has("--keep-going");
const jsonOut = argOf("--json");
const finalDir = noInstall ? join(repo, "test-output", "wasm-bundle-stage") : outDir;

const kb = (n) => (n / 1024).toFixed(1) + " KB";
const sizes = (buf) => ({ raw: buf.length, gzip9: gzipSync(buf, { level: 9 }).length, brotli11: brotliCompressSync(buf, { params: { [0x06]: 11 } }).length });
const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", cwd: opts.cwd ?? repo, env: { ...process.env, ...opts.env } });
  if (r.status !== 0) {
    if (opts.capture) console.error((r.stderr || r.stdout || "").slice(-2000));
    if (!keepGoing) process.exit(r.status ?? 1);
    console.error(`[build-wasm-bundle] 步骤失败(继续执行 --keep-going): ${cmd}`);
    return null;
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return r;
};

// 1) wasm-opt 定位(缺工具则自动降级,不阻塞构建)
function findWasmOpt() {
  const cands = [
    process.env.WASM_OPT,
    process.env.BINARYEN_DIR && join(process.env.BINARYEN_DIR, "bin", "wasm-opt.exe"),
  ];
  const cache = join(homedir(), ".cache", "binaryen");
  if (existsSync(cache)) for (const d of readdirSync(cache).sort().reverse()) cands.push(join(cache, d, "bin", "wasm-opt.exe"));
  cands.push("wasm-opt");
  for (const c of cands.filter(Boolean)) {
    const isPath = c.includes("/") || c.includes("\\");
    if (isPath && (!existsSync(c) || !statSync(c).isFile())) continue;
    const p = spawnSync(c, ["--version"], { encoding: "utf8", shell: false });
    if (p.status === 0) return c;
  }
  return null;
}
const wasmOpt = findWasmOpt();
if (opt.toLowerCase() !== "none" && !wasmOpt) {
  console.warn("[build-wasm-bundle] 未找到 wasm-opt(--opt 自动降级为 none)。安装: github.com/WebAssembly/binaryen/releases → %USERPROFILE%/.cache/binaryen/binaryen-version_*/bin");
  opt = "none";
}

// 2) cargo build(尊重 CARGO_TARGET_DIR,避免与其它会话的共享 target 互相冲洗增量缓存)
const targetDir = process.env.CARGO_TARGET_DIR ?? join(crateDir, "target");
const cargoRes = run("cargo", ["build", "--profile", profile, "--target", target], { cwd: crateDir });
const wasmRaw = join(targetDir, target, profile, "deep_engine_wasm.wasm");
if (!cargoRes || !existsSync(wasmRaw)) {
  console.error(`[build-wasm-bundle] cargo 产物缺失: ${wasmRaw}`);
  process.exit(1);
}
console.log(`[build-wasm-bundle] cargo 产物: ${kb(statSync(wasmRaw).size)} raw`);

// 3) wasm-bindgen --target web
const bindgen = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "wasm-bindgen.exe" : "wasm-bindgen");
const bindgenCmd = existsSync(bindgen) ? bindgen : "wasm-bindgen";
mkdirSync(finalDir, { recursive: true });
run(bindgenCmd, ["--target", "web", "--out-dir", finalDir, wasmRaw]);
const bgWasmPath = join(finalDir, "deep_engine_wasm_bg.wasm");
if (!existsSync(bgWasmPath)) {
  console.error(`[build-wasm-bundle] bindgen 产物缺失: ${bgWasmPath}`);
  process.exit(1);
}

// 4) wasm-opt(bindgen 的 _bg.wasm 原地替换;特性基线同 scripts/wasm-optimize.mjs)
if (opt.toLowerCase() !== "none") {
  const tmpOut = bgWasmPath + ".opt";
  run(wasmOpt, [
    `-${opt}`,
    "--enable-bulk-memory", "--enable-sign-ext", "--enable-nontrapping-float-to-int", "--enable-mutable-globals",
    "--strip-producers", bgWasmPath, "-o", tmpOut,
  ]);
  copyFileSync(tmpOut, bgWasmPath);
  rmSync(tmpOut, { force: true });
}

// 5) 体积表
const entries = [];
for (const f of readdirSync(finalDir).sort()) {
  const p = join(finalDir, f);
  if (!statSync(p).isFile()) continue;
  const s = sizes(readFileSync(p));
  entries.push({ file: f, ...s });
}
console.log(`\n=== 产物体积表(${finalDir},opt=${opt},profile=${profile}) ===`);
console.log(`${"文件".padEnd(38)}${"raw".padStart(11)}${"gzip-9".padStart(11)}${"brotli-11".padStart(11)}`);
for (const e of entries) console.log(`${e.file.padEnd(38)}${kb(e.raw).padStart(11)}${kb(e.gzip9).padStart(11)}${kb(e.brotli11).padStart(11)}`);
const wasmE = entries.find((e) => e.file.endsWith(".wasm"));
const jsE = entries.find((e) => e.file.endsWith(".js"));
if (wasmE && jsE) {
  console.log(`\n合计(wasm+js): raw=${kb(wasmE.raw + jsE.raw)} gzip-9=${kb(wasmE.gzip9 + jsE.gzip9)} brotli-11=${kb(wasmE.brotli11 + jsE.brotli11)}`);
  console.log(`参考:Unity WebGL 同级产物 7-10 MiB+(gzip 前);本引擎 wasm+js raw=${((wasmE.raw + jsE.raw) / 1048576).toFixed(2)} MiB`);
}
if (jsonOut) {
  writeFileSync(resolve(jsonOut), JSON.stringify({ profile, target, opt, outDir: finalDir, entries, at: new Date().toISOString() }, null, 2));
  console.log(`\n[json] ${resolve(jsonOut)}`);
}
if (!noInstall) console.log(`[build-wasm-bundle] 已安装到 ${outDir}(Vite public 静态目录,import 路径不变)`);
