import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * J5 强制双端验收门(依 剩余任务清单.md J 级表 J5 行 + docs/reports/deep-core/
 * J3-gate-c-physics-parity-20260929.md):把白炉/身份黄金/布料软体指纹/Runtime
 * Package hash 既有 gate 从"可选跑"升格为"提交前强制双端跑"。
 *
 * 规则:
 * - 一条命令串联全部判据,每对各有 TS 腿 + Native 腿;任一端红即门失败(fail-closed)。
 * - GPU 腿(TS 白炉 headless Chrome 真机腿)由 flag 控制:默认 CPU/静态口径;
 *   --with-gpu / J5_GATE_GPU=on|auto 时先探测 adapter,无 adapter 自动跳过 GPU 腿
 *   但保留 CPU 判据,并如实输出跳过原因(降级通过,证据里标 degraded);
 *   --require-gpu / J5_GATE_GPU=strict 时无 adapter 即门失败(CI 严格档)。
 * - 本脚本只做编排:不实现任何判据,判据全部在既有测试文件里(只读复用)。
 * - 证据落 test-output/j5-dual-end-gate/(evidence-<stamp>.json 与 evidence-latest.json,
 *   含逐腿状态/耗时/失败尾部摘录),双端对照表打 stdout。
 */

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const CARGO_TEST_BASE = ["cargo", "test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked"];
const vitestCommand = (files) => `pnpm --filter @bim-studio/deep-engine exec vitest run ${files.join(" ")}`;
const cargoCommand = (cargoArgs) => `cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked ${cargoArgs}`;

/** 全部判据映射(判据与命令锚定既有文件,漂移即两侧 package.json/本文件同步改)。 */
export const GATE_PAIRS = [
  {
    id: "white-furnace",
    name: "白炉能量守恒(C12/J2-B3)",
    legs: [
      {
        id: "white-furnace:ts-gpu", side: "ts", requiresGpu: true,
        command: "pnpm --filter @bim-studio/deep-engine test:white-furnace-gpu",
        note: "headless Chrome 真机 WebGPU,背景/几何/SSR 双腿守恒",
      },
      {
        id: "white-furnace:native", side: "native", requiresGpu: false,
        command: cargoCommand("--lib white_furnace"),
        note: "lib CPU 判据强制(容差对拍 TS 权威/构造性守恒/缺陷模型);GPU 真机腿设备门控自跳过",
      },
    ],
  },
  {
    id: "identity-golden",
    name: "身份黄金对拍(P0-07/J3 Gate A/B 全家族)",
    legs: [
      {
        id: "identity-golden:ts", side: "ts", requiresGpu: false,
        command: vitestCommand([
          "src/runtimePackage/identityGolden.test.ts",
          "src/runtimePackage/runtimePackageFamiliesIdentity.test.ts",
        ]),
        note: "dashboard 组合包 + author-lod + 全家族身份视图 vs 入库 golden",
      },
      {
        id: "identity-golden:native", side: "native", requiresGpu: false,
        command: cargoCommand("--test dashboard_identity_golden"),
        note: "生产合同解析(deny_unknown_fields + 包哈希)+ 同规则视图逐字段对拍",
      },
    ],
  },
  {
    id: "cloth-softbody-fingerprint",
    name: "布料/软体跨端指纹逐位(J3 Gate C)",
    legs: [
      {
        id: "cloth-softbody:ts", side: "ts", requiresGpu: false,
        command: vitestCommand(["src/physics/clothSoftBodyCrossLanguageParity.test.ts"]),
        note: "F6 基线求解器重放 4 场景指纹 vs 共享 fixture",
      },
      {
        id: "cloth-softbody:native", side: "native", requiresGpu: false,
        command: cargoCommand("--test cloth_softbody_solver_parity"),
        note: "Rust 镜像 f64 逐位 + 动态场景生产合同验收",
      },
    ],
  },
  {
    id: "runtime-package-hash",
    name: "Runtime Package hash(TS builder == Native fixture,7089eba4)",
    legs: [
      {
        id: "runtime-package-hash:ts", side: "ts", requiresGpu: false,
        command: vitestCommand(["src/runtimePackage/runtimePackageAuthorLod.test.ts"]),
        note: "TS builder 包哈希钉住入库 fixture",
      },
      {
        id: "runtime-package-hash:native", side: "native", requiresGpu: false,
        command: cargoCommand("--test dashboard_identity_golden"),
        note: "与身份黄金同二进制:author-lod fixture 过 parse_and_validate_runtime_package(重算包哈希,fail-closed);命令级复用不重复执行",
      },
    ],
  },
  {
    id: "frame-abi-schema",
    name: "frame ABI schema 单源指纹(J2-B7-adopt)",
    legs: [
      {
        id: "frame-abi:ts", side: "ts", requiresGpu: false,
        command: vitestCommand(["src/frameAbi/generated/frameLayout.test.ts"]),
        note: "产物指纹戳==当前 schema sha256+双端手写真值 parity；任何 frame 字段变更必须改 schema 再生成(漂移即红,adopt 纪律强制)",
      },
      {
        id: "frame-abi:native", side: "native", requiresGpu: false,
        command: cargoCommand("--lib frame_layout"),
        note: "include_str! schema 原文重算 sha256 对生成戳+与 mesh_abi 手写常量 parity(2384B 字节门同链)",
      },
    ],
  },
  {
    id: "display-output-common-subset",
    name: "输出色彩共同子集像素对拍(J3 Gate D/C8 首刀)",
    legs: [
      { id: "display-output:ts-gpu", side: "ts", requiresGpu: true,
        command: "node scripts/j3-display-parity.mjs", note: "TS 生产输出+WGSL/GLSL 浮点库；同 runner 比较双端，两轮稳定性门" },
      { id: "display-output:native-gpu", side: "native", requiresGpu: true,
        command: "node scripts/j3-display-parity.mjs", note: "native 生产 OutputPass；命令去重复用完整双端证据，非整场景 Gate D" },
    ],
  },
  {
    id: "lifecycle-host-components",
    name: "真实宿主生命周期轨迹(J3 Gate E CPU 首刀)",
    legs: [
      { id: "lifecycle:ts", side: "ts", requiresGpu: false,
        command: "node scripts/j3-lifecycle-parity.mjs", note: "真实 resource executor，五情景双轮；比较阶段、代次与 CPU 测试资源" },
      { id: "lifecycle:native", side: "native", requiresGpu: false,
        command: "node scripts/j3-lifecycle-parity.mjs", note: "生产 coalescer/mailbox/PublishedState/WatchThread；同 runner 双端比较并去重，不认证 GPU 生命周期" },
    ],
  },
  {
    id: "probe-storage-vectors",
    name: "探针 GI storage 生产函数向量对拍(J2-B5)",
    legs: [
      { id: "probe-storage:ts-gpu", side: "ts", requiresGpu: true,
        command: "node scripts/j2-probe-gi-parity.mjs", note: "两轮实际 Chrome/Native，共同夹具和生产 source 身份门" },
      { id: "probe-storage:native-gpu", side: "native", requiresGpu: true,
        command: "node scripts/j2-probe-gi-parity.mjs", note: "默认清旧证据并执行本次 Native GPU；命令去重，不认证 texture/整帧" },
    ],
  },
  {
    id: "device-recovery-host-components",
    name: "实际设备销毁与生产组件重开(J3 Gate E GPU 首刀)",
    legs: [
      { id: "device-recovery:ts-gpu", side: "ts", requiresGpu: true,
        command: "node scripts/j3-device-recovery-parity.mjs", note: "实际 PbrRenderer：lost、退役、重传、有效首帧；两轮" },
      { id: "device-recovery:native-gpu", side: "native", requiresGpu: true,
        command: "node scripts/j3-device-recovery-parity.mjs", note: "实际 Native 生产组件跨 lost 存活后退役；同包分阶段，不认证自动恢复/显存" },
    ],
  },
  {
    id: "geometry-main-depth",
    name: "共同 RenderPacket 几何与主深度(J3 Gate D)",
    legs: [
      { id: "geometry-depth:ts-gpu", side: "ts", requiresGpu: true,
        command: "node scripts/j3-geometry-depth-parity.mjs", note: "生产 PbrRenderer，同包双相机双轮；上传矩阵与实际主深度" },
      { id: "geometry-depth:native-gpu", side: "native", requiresGpu: true,
        command: "node scripts/j3-geometry-depth-parity.mjs", note: "生产 mesh pass 保留观察深度；4xMSAA 合法边界，不认证材质色差" },
    ],
  },
];

/** GPU 腿策略:off=默认 CPU/静态口径;auto=探测可用才跑;strict=不可用即门失败。
 *  优先级:CLI flag(多个同给时最后一个生效)> J5_GATE_GPU > 默认 off。 */
export function resolveGpuPolicy({ argv = [], env = process.env } = {}) {
  const flagMap = { "--with-gpu": "auto", "--require-gpu": "strict", "--no-gpu": "off" };
  let fromCli = null;
  for (const arg of argv) {
    if (flagMap[arg]) fromCli = flagMap[arg];
    if (arg.startsWith("--gpu-policy=")) {
      const value = arg.split("=")[1];
      if (!["off", "auto", "strict"].includes(value)) throw new Error(`非法 --gpu-policy: ${value}(可选 off|auto|strict)`);
      fromCli = value;
    }
  }
  if (fromCli) return fromCli;
  const fromEnv = (env.J5_GATE_GPU ?? "").toLowerCase();
  if (fromEnv === "on" || fromEnv === "auto") return "auto";
  if (fromEnv === "strict") return "strict";
  return "off";
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export function parseArgs(argv = []) {
  const timeoutFlag = argv.find((arg) => arg.startsWith("--timeout-ms="));
  const timeoutMs = timeoutFlag ? Number(timeoutFlag.split("=")[1]) : Number(process.env.J5_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("非法 --timeout-ms / J5_GATE_TIMEOUT_MS");
  return {
    gpuPolicy: resolveGpuPolicy({ argv }),
    timeoutMs,
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

/** GPU adapter 探测:与 whiteFurnaceGpuTest.mjs 同一套宿主(playwright-core + 系统 Chrome)。 */
export async function probeGpuAvailability({
  chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  playwrightPath = path.join(repoRoot, "apps/cloud-render-worker/node_modules/playwright-core/index.js"),
} = {}) {
  const unavailable = (reason) => ({ available: false, reason });
  let playwrightModule;
  try {
    playwrightModule = await import(pathToFileUrl(playwrightPath));
  } catch {
    return unavailable(`playwright-core 不可用(${playwrightPath});GPU 腿宿主缺失`);
  }
  try {
    await access(chromePath);
  } catch {
    return unavailable(`Chrome 不存在(${chromePath});可用 BIM_STUDIO_CHROME_PATH 指定`);
  }
  let browser;
  let probeServer;
  try {
    const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
    if (!chromium) return unavailable("playwright-core 未导出 chromium");
    browser = await chromium.launch({
      executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"],
    });
    probeServer = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>GPU probe</title>");
    });
    await new Promise((resolve, reject) => {
      probeServer.once("error", reject); probeServer.listen(0, "127.0.0.1", resolve);
    });
    const page = await browser.newPage();
    // WebGPU needs a trustworthy origin; about:blank does not expose navigator.gpu here.
    await page.goto(`http://127.0.0.1:${probeServer.address().port}/`);
    const probe = await page.evaluate(async () => {
      if (!navigator.gpu) return { supported: false, adapter: false };
      const adapter = await navigator.gpu.requestAdapter();
      return { supported: true, adapter: adapter !== null };
    });
    await browser.close();
    if (!probe.supported) return unavailable("headless Chrome 未暴露 navigator.gpu(缺少 --enable-unsafe-webgpu 生效的 WebGPU 实现)");
    if (!probe.adapter) return unavailable("headless Chrome requestAdapter() 返回空(无可用 GPU adapter)");
    return { available: true, reason: "headless Chrome WebGPU adapter 可用" };
  } catch (error) {
    return unavailable(`GPU 探测失败:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close().catch(() => {});
    if (probeServer?.listening) await new Promise(resolve => probeServer.close(resolve));
  }
}

function pathToFileUrl(filePath) {
  const url = path.resolve(filePath).replaceAll("\\", "/");
  return new URL(`file:///${url.startsWith("/") ? url.slice(1) : url}`);
}

/** 真实执行器:win32 走 cmd /c(与 batchFGateRun.mjs 同惯例),其余走 sh -c。 */
export function createSpawnRunner({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return function runLeg(leg) {
    const startedAt = Date.now();
    const isWin = process.platform === "win32";
    const proc = isWin
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", leg.command], {
          cwd: repoRoot, encoding: "utf8", timeout: timeoutMs, windowsHide: true,
          env: { ...process.env, FORCE_COLOR: "0" },
        })
      : spawnSync("/bin/sh", ["-c", leg.command], {
          cwd: repoRoot, encoding: "utf8", timeout: timeoutMs,
          env: { ...process.env, FORCE_COLOR: "0" },
        });
    const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const error = proc.error ? `${proc.error.code ?? ""} ${proc.error.message}`.trim() : null;
    return {
      status: proc.status === 0 ? 0 : (proc.status ?? "error"),
      durationMs: Date.now() - startedAt,
      tail: (error ? [error, ...lines] : lines).slice(-5).join(" | ").slice(0, 500),
    };
  };
}

/**
 * 门编排(可注入 runLeg/gpuAvailability,供门自测使用):
 * - 逐对双腿执行,相同 command 只执行一次(身份黄金与包哈希共用 native 二进制);
 * - requiresGpu 腿按策略决定跑/跳;任一非跳过腿红即门失败;strict 下跳过也算失败。
 */
export function executeGate({ pairs = GATE_PAIRS, gpuPolicy = "off", gpuAvailability = null, runLeg }) {
  if (typeof runLeg !== "function") throw new Error("executeGate 需要可注入的 runLeg");
  const results = new Map();
  const pairsOut = [];
  for (const pair of pairs) {
    const cells = pair.legs.map((leg) => {
      const cached = results.get(leg.command);
      if (cached) {
        return { ...leg, ...cached, deduped: true, detail: cached.detail ?? "同命令已执行,复用其结果" };
      }
      let outcome;
      if (leg.requiresGpu) {
        if (gpuPolicy === "off") {
          outcome = { status: "SKIP", detail: "GPU 腿未启用(默认 CPU/静态口径;--with-gpu 或 J5_GATE_GPU=on 开启)" };
        } else if (!gpuAvailability?.available) {
          outcome = { status: "SKIP", detail: gpuAvailability?.reason ?? "GPU adapter 不可用" };
        } else {
          outcome = { status: "RUN" };
        }
      } else {
        outcome = { status: "RUN" };
      }
      if (outcome.status !== "RUN") {
        const cell = { ...leg, ...outcome, durationMs: 0, deduped: false };
        results.set(leg.command, { status: cell.status, detail: cell.detail, durationMs: 0 });
        return cell;
      }
      const { status, durationMs, tail } = runLeg(leg);
      const cell = {
        ...leg,
        status: status === 0 ? "PASS" : "FAIL",
        durationMs,
        detail: status === 0 ? "" : tail,
        deduped: false,
      };
      results.set(leg.command, { status: cell.status, detail: cell.detail, durationMs });
      return cell;
    });
    const failed = cells.filter((cell) => cell.status === "FAIL");
    pairsOut.push({ id: pair.id, name: pair.name, cells, failed });
  }
  const allCells = pairsOut.flatMap((pair) => pair.cells);
  const failedCells = allCells.filter((cell) => cell.status === "FAIL");
  const skippedCells = allCells.filter((cell) => cell.status === "SKIP");
  const strictBlocked = gpuPolicy === "strict" && skippedCells.length > 0;
  return {
    ok: failedCells.length === 0 && !strictBlocked,
    degraded: skippedCells.length > 0,
    gpuPolicy,
    gpuProbe: gpuAvailability,
    pairs: pairsOut,
    failedCells,
    skippedCells,
    strictBlocked,
  };
}

function formatSeconds(durationMs) {
  return durationMs >= 60_000 ? `${(durationMs / 60_000).toFixed(1)}m` : `${(durationMs / 1000).toFixed(1)}s`;
}

/** 双端对照表(全部判据 × TS/Native 腿)+ 逐腿明细。 */
export function formatReport(result) {
  const lines = [];
  lines.push(`J5 强制双端验收门 — GPU 策略=${result.gpuPolicy}${result.gpuProbe ? `(探测: ${result.gpuProbe.available ? "可用" : "不可用"})` : ""}`);
  for (const pair of result.pairs) {
    lines.push(`\n[${pair.id}] ${pair.name}`);
    for (const cell of pair.cells) {
      const suffix = cell.deduped ? "(复用同命令结果)" : cell.durationMs ? ` ${formatSeconds(cell.durationMs)}` : "";
      lines.push(`  ${cell.side.padEnd(6)} ${cell.status.padEnd(4)}${suffix}  ${cell.command}${cell.detail ? `\n         ↳ ${cell.detail}` : ""}${cell.requiresGpu && cell.status !== "SKIP" ? "\n         ↳ (GPU 腿,真机)" : ""}`);
    }
  }
  lines.push("");
  const planning = result.pairs.some((pair) => pair.cells.some((cell) => cell.status === "PLAN"));
  if (planning) {
    lines.push("门判定: PLAN(未执行) — 以上为计划;复跑一条命令: node scripts/j5-dual-end-gate.mjs(--with-gpu 含 GPU 腿)。");
  } else if (!result.ok) {
    lines.push(`门判定: FAIL — ${result.failedCells.length} 条腿红${result.strictBlocked ? ";strict 策略下 GPU 腿被跳过同样算失败" : ""}`);
    for (const cell of result.failedCells) lines.push(`  [红] ${cell.id}: ${cell.detail || cell.command}`);
  } else if (result.degraded) {
    lines.push(`门判定: PASS(降级) — 判据双端绿;GPU 腿跳过 ${result.skippedCells.length} 项(降级为 CPU/静态口径,已如实标注):`);
    for (const cell of result.skippedCells) lines.push(`  [跳过] ${cell.id}: ${cell.detail}`);
  } else {
    lines.push("门判定: PASS — 全部判据双端全绿(含 GPU 腿)。");
  }
  return lines.join("\n");
}

export function buildEvidence(result, { date = new Date().toISOString(), timeoutMs } = {}) {
  return {
    schema: "deep-engine.j5-dual-end-gate",
    schemaVersion: 1,
    date,
    gpuPolicy: result.gpuPolicy,
    gpuProbe: result.gpuProbe,
    timeoutMs: timeoutMs ?? null,
    ok: result.ok,
    degraded: result.degraded,
    strictBlocked: result.strictBlocked,
    pairs: result.pairs.map((pair) => ({
      id: pair.id, name: pair.name,
      legs: pair.cells.map(({ id, side, command, requiresGpu, note, status, durationMs, detail, deduped }) =>
        ({ id, side, command, requiresGpu, note, status, durationMs, detail, deduped })),
    })),
  };
}

async function writeEvidenceAndLogs(result, { timeoutMs, date }) {
  const stamp = date.replace(/[-:T]/g, "").slice(0, 14);
  const outDir = path.join(repoRoot, "test-output", "j5-dual-end-gate");
  await mkdir(outDir, { recursive: true });
  const evidence = buildEvidence(result, { date, timeoutMs });
  await writeFile(path.join(outDir, `evidence-${stamp}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(path.join(outDir, "evidence-latest.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return path.join(outDir, `evidence-${stamp}.json`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node scripts/j5-dual-end-gate.mjs [--with-gpu|--require-gpu|--no-gpu] [--gpu-policy=off|auto|strict] [--timeout-ms=N] [--dry-run]
全部判据: ${GATE_PAIRS.map(pair => pair.name).join(" / ")}。
GPU 策略: 默认 off(CPU/静态口径);auto=探测可用才跑 GPU 腿,否则跳过并标注;strict=GPU 腿不可用即门失败。
环境变量: J5_GATE_GPU=on|auto|strict、J5_GATE_TIMEOUT_MS;证据落 test-output/j5-dual-end-gate/。`);
    return;
  }
  let gpuAvailability = null;
  if (!args.dryRun && args.gpuPolicy !== "off") {
    console.log(`[J5] GPU 策略=${args.gpuPolicy},探测 WebGPU adapter...`);
    gpuAvailability = await probeGpuAvailability();
    console.log(`[J5] 探测结果: ${gpuAvailability.available ? "可用" : `不可用(${gpuAvailability.reason})`}`);
  }
  if (args.dryRun) {
    console.log(`[J5] dry-run:只列计划不执行。GPU 策略=${args.gpuPolicy}(${args.gpuPolicy === "off" ? "GPU 腿将跳过" : "执行前将探测 adapter"})`);
    const dry = { ok: true, degraded: false, gpuPolicy: args.gpuPolicy, gpuProbe: null,
      pairs: GATE_PAIRS.map((pair) => ({ ...pair, cells: pair.legs.map((leg) => ({ ...leg, status: "PLAN", durationMs: 0, deduped: false, detail: "" })), failed: [] })),
      failedCells: [], skippedCells: [], strictBlocked: false };
    console.log(formatReport(dry));
    return;
  }
  const runLeg = createSpawnRunner({ timeoutMs: args.timeoutMs });
  const date = new Date().toISOString();
  console.log(`[J5] 强制双端验收门开始(${date};超时 ${formatSeconds(args.timeoutMs)}/腿)`);
  const result = executeGate({ gpuPolicy: args.gpuPolicy, gpuAvailability, runLeg });
  const evidencePath = await writeEvidenceAndLogs(result, { timeoutMs: args.timeoutMs, date });
  console.log(formatReport(result));
  console.log(`[J5] 证据: ${evidencePath}(latest 同步)`);
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
