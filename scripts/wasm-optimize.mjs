#!/usr/bin/env node
/**
 * wasm-optimize.mjs — wasm-opt 极致管线(体积档位实测对比工具)
 *
 * 用法:
 *   node scripts/wasm-optimize.mjs <input.wasm | --pkg <dir>> [options]
 *
 * 功能:
 *   1. 定位 binaryen 的 wasm-opt(PATH / WASM_OPT / BINARYEN_DIR / 仓库 tools/ / ~/.cache/binaryen)。
 *   2. 对输入 wasm 依次跑基线(不优化)与 -O3 / -Os / -Oz 档位(可选 --converge 收敛迭代)。
 *   3. 每档输出 raw / gzip-9 / brotli-11 三口径体积表 + 相对基线差值,并给出推荐档位。
 *   4. 结果可写 JSON(--json <file>),便于 CI 与报告引用。
 *
 * 选项:
 *   --pkg <dir>        直接取 <dir>/*_bg.wasm 作为输入(报告同时记录同目录 .js 体积)
 *   --out <dir>        优化产物输出目录(默认 <input 同目录>/wasm-opt-out;不会覆盖输入)
 *   --levels <list>    逗号分隔档位,默认 "O3,Os,Oz"
 *   --wasm-opt <path>  显式指定 wasm-opt 可执行文件
 *   --converge         在最优档位上追加 --converge(多轮迭代,慢,一般再省 0.2%~1%)
 *   --strip-all        额外剥离 name/producers 段(牺牲可读的堆栈函数名,换最小体积)
 *   --json <file>      把体积表写成 JSON
 *   --quiet            只打印表格
 *
 * 退出码:0 成功;1 输入缺失;2 wasm-opt 不可得(此时仍输出基线体积表)。
 */
import { spawnSync } from "node:child_process";
import { brotliCompressSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

// ---------- CLI ----------
const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}
const has = (f) => argv.includes(f);

let input = null;
let pkgDir = argOf("--pkg");
const outDirOpt = argOf("--out");
const levelsArg = argOf("--levels") ?? "O3,Os,Oz";
const wasmOptExplicit = argOf("--wasm-opt") ?? process.env.WASM_OPT;
const converge = has("--converge");
const stripAll = has("--strip-all");
const jsonOut = argOf("--json");
const quiet = has("--quiet");

function log(msg) {
  if (!quiet) process.stdout.write(msg + "\n");
}
const out = (msg) => process.stdout.write(msg + "\n"); // 表格始终打印(--quiet 只压进度行)

// ---------- 输入解析 ----------
if (pkgDir) {
  const dir = resolve(pkgDir);
  if (!existsSync(dir)) {
    console.error(`[wasm-optimize] --pkg 目录不存在: ${dir}`);
    process.exit(1);
  }
  const bg = readdirSync(dir).find((f) => f.endsWith("_bg.wasm"));
  if (!bg) {
    console.error(`[wasm-optimize] --pkg 目录中没有 *_bg.wasm: ${dir}`);
    process.exit(1);
  }
  input = join(dir, bg);
} else if (argv[0] && !argv[0].startsWith("--")) {
  input = resolve(argv[0]);
} else {
  console.error("用法: node scripts/wasm-optimize.mjs <input.wasm | --pkg <dir>> [--out dir] [--levels O3,Os,Oz] [--converge] [--strip-all] [--json file]");
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`[wasm-optimize] 输入不存在: ${input}`);
  process.exit(1);
}
const inputBuf = readFileSync(input);

// ---------- wasm-opt 定位 ----------
function* candidates() {
  if (wasmOptExplicit) yield wasmOptExplicit;
  if (process.env.BINARYEN_DIR) yield join(process.env.BINARYEN_DIR, "bin", "wasm-opt.exe");
  if (process.env.BINARYEN_DIR) yield join(process.env.BINARYEN_DIR, "wasm-opt.exe");
  // 仓库内 vendored(如未来有团队统一 vendor)
  const repo = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  for (const base of [join(repo, "tools"), join(repo, "node_modules", ".bin")]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name.toLowerCase().includes("binaryen")) {
        yield join(base, name, "bin", "wasm-opt.exe");
        yield join(base, name, "wasm-opt.exe");
      }
      if (name.toLowerCase() === "wasm-opt.exe" || name.toLowerCase() === "wasm-opt") yield join(base, name);
    }
  }
  // 用户缓存(本仓库文档约定:~/.cache/binaryen/binaryen-version_*/bin)
  const cache = join(homedir(), ".cache", "binaryen");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).sort().reverse()) {
      yield join(cache, d, "bin", "wasm-opt.exe");
      yield join(cache, d, "bin", "wasm-opt");
    }
  }
  // PATH
  yield "wasm-opt";
}
function findWasmOpt() {
  for (const c of candidates()) {
    if (c === "wasm-opt") {
      const probe = spawnSync("wasm-opt", ["--version"], { encoding: "utf8", shell: false });
      if (probe.status === 0) return { path: "wasm-opt", version: probe.stdout.trim() };
    } else if (existsSync(c) && statSync(c).isFile()) {
      const probe = spawnSync(c, ["--version"], { encoding: "utf8" });
      if (probe.status === 0) return { path: resolve(c), version: probe.stdout.trim() };
    }
  }
  return null;
}
const tool = findWasmOpt();

// ---------- 体积口径 ----------
const sizes = (buf) => ({
  raw: buf.length,
  gzip9: gzipSync(buf, { level: 9 }).length,
  brotli11: brotliCompressSync(buf, { params: { [0x06]: 11 } }).length, // 0x06 = quality
});
const kb = (n) => (n / 1024).toFixed(1) + " KB";
const pct = (a, b) => (b ? ((a - b) / b * 100).toFixed(1) + "%" : "n/a");

// ---------- 跑档位 ----------
const outDir = outDirOpt ? resolve(outDirOpt) : join(dirname(input), "wasm-opt-out");
mkdirSync(outDir, { recursive: true });
const base = basename(input, ".wasm");
const levels = levelsArg.split(",").map((s) => s.trim()).filter(Boolean);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

const rows = [];
rows.push({
  level: "baseline(bindgen 原样)",
  file: input,
  sha: sha256(inputBuf),
  ...sizes(inputBuf),
  note: "未过 wasm-opt",
});

const wasmFeatures = argOf("--features"); // 额外 --enable-* 特性;rustc wasm32 默认含 bulk-memory/sign-ext/mutable-globals
const featureArgs = [
  // rustc wasm32-unknown-unknown 默认目标特性(全浏览器基线,无兼容代价),过 binaryen 校验必需
  "--enable-bulk-memory",
  "--enable-sign-ext",
  "--enable-nontrapping-float-to-int",
  "--enable-mutable-globals",
  ...(wasmFeatures ? wasmFeatures.split(",").filter(Boolean).map((f) => `--enable-${f.trim()}`) : []),
];
let best = null;
if (tool) {
  log(`[wasm-optimize] wasm-opt: ${tool.path} (${tool.version})`);
  log(`[wasm-optimize] 输入: ${input} (${kb(inputBuf.length)} raw)`);
  log(`[wasm-optimize] 输出目录: ${outDir}`);
  const tmp = mkdtempIn(tmpdir());
  try {
    for (const level of levels) {
      // binaryen 档位旗标大小写敏感:-O3 / -Os / -Oz,按用户传入原样使用
      const args = [`-${level}`, ...featureArgs, "--strip-producers", input, "-o", join(tmp, `${base}.${level}.wasm`)];
      if (stripAll) args.push("--strip-dwarf");
      const t0 = Date.now();
      const r = spawnSync(tool.path, args, { encoding: "utf8" });
      const outFile = join(tmp, `${base}.${level}.wasm`);
      if (r.status !== 0 || !existsSync(outFile)) {
        rows.push({ level, error: (r.stderr || r.stdout || "wasm-opt 失败").trim().slice(0, 400) });
        continue;
      }
      let buf = readFileSync(outFile);
      // converge:在同一档位上反复迭代直至稳定(binaryen 官方推荐用法)
      if (converge) {
        for (let i = 0; i < 5; i++) {
          const rc = spawnSync(tool.path, [`${level}`, "--converge", ...featureArgs, "--strip-producers", outFile, "-o", join(tmp, `${base}.${level}.c${i}.wasm`)], { encoding: "utf8" });
          const cf = join(tmp, `${base}.${level}.c${i}.wasm`);
          if (rc.status !== 0 || !existsSync(cf)) break;
          const nb = readFileSync(cf);
          if (nb.length >= buf.length) { break; }
          buf = nb;
        }
      }
      const dest = join(outDir, `${base}.${level}.wasm`);
      writeFileSync(dest, buf);
      const s = sizes(buf);
      const row = { level, file: dest, sha: sha256(buf), ...s, ms: Date.now() - t0 };
      rows.push(row);
      if (!best || s.gzip9 < best.s.gzip9) best = { level, s, dest };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  log("[wasm-optimize] 未找到 wasm-opt(binaryen)。仅输出基线体积表。");
  log("[wasm-optimize] 获取方式: https://github.com/WebAssembly/binaryen/releases (建议固定 version_xxx 并校验 .sha256)");
  log("[wasm-optimize] 本仓库约定解压到 %USERPROFILE%/.cache/binaryen/binaryen-version_<n>/ (bin/wasm-opt.exe)");
}

// ---------- 同目录 JS 参考 ----------
let jsInfo;
{
  const js = join(dirname(input), base.replace(/_bg$/, "") + ".js");
  const js2 = pkgDir ? readdirSync(resolve(pkgDir)).find((f) => f.endsWith(".js")) : undefined;
  const jsPath = existsSync(js) ? js : js2 ? join(resolve(pkgDir), js2) : null;
  if (jsPath) {
    const b = readFileSync(jsPath);
    jsInfo = { file: jsPath, ...sizes(b) };
  }
}

// ---------- 表格 ----------
const baseRow = rows[0];
log("");
log(`=== wasm 体积表(${basename(input)},sha256:${baseRow.sha}) ===`);
log(`${"档位".padEnd(26)}${"raw".padStart(11)}${"gzip-9".padStart(11)}${"brotli-11".padStart(11)}${"raw Δ".padStart(10)}`);
for (const r of rows) {
  if (r.error) {
    log(`${r.level.padEnd(26)}失败: ${r.error}`);
    continue;
  }
  log(`${r.level.padEnd(26)}${kb(r.raw).padStart(11)}${kb(r.gzip9).padStart(11)}${kb(r.brotli11).padStart(11)}${pct(r.raw, baseRow.raw).padStart(10)}`);
}
if (jsInfo) {
  log(`\n[参考] bindgen JS 胶水: ${basename(jsInfo.file)} raw=${kb(jsInfo.raw)} gzip-9=${kb(jsInfo.gzip9)} brotli-11=${kb(jsInfo.brotli11)}(本工具不改 JS;JS 可另经 terser/esbuild 压缩)`);
}
if (best) {
  log(`\n[推荐] ${best.level}(gzip-9 最小:${kb(best.s.gzip9)},brotli-11:${kb(best.s.brotli11)})`);
  log(`[推荐] 相对基线: raw ${(100 - best.s.raw / baseRow.raw * 100).toFixed(1)}% ↓, gzip-9 ${(100 - best.s.gzip9 / baseRow.gzip9 * 100).toFixed(1)}% ↓`);
}

if (jsonOut) {
  writeFileSync(resolve(jsonOut), JSON.stringify({ input, tool, js: jsInfo, rows, best: best?.level ?? null, measuredAt: new Date().toISOString() }, null, 2));
  log(`\n[json] 已写入 ${resolve(jsonOut)}`);
}
process.exit(tool ? 0 : 2);

// ---------- utils ----------
function mkdtempIn(root) {
  const dir = join(root, `wasm-optimize-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
