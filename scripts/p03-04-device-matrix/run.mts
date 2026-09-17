// P3-04 Windows 设备/驱动能力矩阵 —— 单机可执行切片 总驱动。
// 流程：构建并运行 Rust harness（Vulkan/DX12 × 3 尺寸 × producer 包 + 字体 + 设备丢失读回）
// → .rgba 经 sharp 转 PNG → PowerShell 采集环境指纹（DPI/内存/驱动/分辨率）
// → 真实 Chrome WebGPU 强制后端探测（vulkan/d3d11/d3d12，仅适配器级）→ matrix.json + environment.json。
// 不改生产源码；产物只写 test-output/p03-04-device-matrix-20260918/。
// 用法: node_modules/.bin/tsx scripts/p03-04-device-matrix/run.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const output = resolve(repo, "test-output/p03-04-device-matrix-20260918");
const harnessDir = resolve(repo, "scripts/p03-04-device-matrix/harness");
const packagePath = resolve(repo, "test-output/dashboard-http-multicomponent-20260917/extracted/runtime-package.json");
const fontsDir = resolve(repo, "test-output/dashboard-multicomponent-fonts-20260917");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function fail(message) {
  console.error(`P03-04 MATRIX FAIL: ${message}`);
  process.exit(1);
}
function step(message) {
  console.log(`[p03-04] ${message}`);
}

const requireFrom = (segment) => createRequire(join(repo, segment, "package.json"));
const sharp = requireFrom("apps/web")("sharp");

if (!existsSync(packagePath)) fail(`producer 包不存在: ${packagePath}`);
if (!existsSync(fontsDir)) fail(`冻结字体目录不存在: ${fontsDir}`);

// ---------- 1. 构建 Rust harness ----------
step("cargo build harness");
execFileSync("cargo", ["build"], { cwd: harnessDir, stdio: "inherit", shell: true });
const exeName = process.platform === "win32" ? "p03-04-device-matrix.exe" : "p03-04-device-matrix";
const harnessExe = join(harnessDir, "target", "debug", exeName);
if (!existsSync(harnessExe)) fail(`harness 未生成: ${harnessExe}`);

// ---------- 2. 运行矩阵读回 ----------
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "raw"), { recursive: true });
mkdirSync(join(output, "png"), { recursive: true });
step("run GPU readback matrix (vulkan/dx12 × 3 sizes × fonts × device loss)");
execFileSync(harnessExe, ["--out", output, "--package", packagePath, "--fonts", fontsDir], {
  stdio: "inherit",
});
const raw = JSON.parse(readFileSync(join(output, "matrix_raw.json"), "utf8"));
if (raw.fatalError) fail(`harness 失败: ${raw.fatalError}`);

// ---------- 3. RGBA → PNG ----------
async function rgbaToPng(rgbaPath, pngPath, width, height) {
  const rgba = readFileSync(rgbaPath);
  if (rgba.length !== width * height * 4) fail(`${rgbaPath}: 字节数 ${rgba.length} ≠ ${width}×${height}×4`);
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .png()
    .toBuffer();
  writeFileSync(pngPath, png);
}
step("convert raw rgba to png");
const pngFiles = [];
for (const cell of [...raw.cells, ...raw.fontCells]) {
  const [width, height] = cell.physical;
  const rgbaPath = join(output, cell.file);
  const pngPath = join(output, "png", `${cell.id}.png`);
  await rgbaToPng(rgbaPath, pngPath, width, height);
  pngFiles.push({ id: cell.id, png: `png/${cell.id}.png`, width, height });
}
const diffMasks = [
  [raw.backendDiff, "diff-backend-vulkan-vs-dx12"],
  [raw.fontDiff, "diff-font-yahei-vs-noto"],
];
for (const [label, diff] of Object.entries(raw.deviceLoss ?? {})) {
  if (diff.diff?.maskFile) diffMasks.push([diff.diff, `diff-deviceloss-${label}`]);
}
for (const [section, name] of diffMasks) {
  if (!section?.maskFile) continue;
  const width = section.physical?.[0] ?? 960;
  const height = section.physical?.[1] ?? 540;
  const pngPath = join(output, "png", `${name}.png`);
  await rgbaToPng(join(output, section.maskFile), pngPath, width, height);
  pngFiles.push({ id: name, png: `png/${name}.png`, width, height, diffMask: true });
}

// ---------- 4. 环境指纹（PowerShell） ----------
step("collect environment fingerprint");
let envPs = {};
try {
  const psCommand = [
    "$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, TotalVisibleMemorySize, FreePhysicalMemory;",
    "$gpu = Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate, AdapterDACType, CurrentHorizontalResolution, CurrentVerticalResolution;",
    "$cs = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, PCSystemType;",
    "$dpi = (Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI).AppliedDPI;",
    "[pscustomobject]@{ os = $os; gpus = @($gpu); system = $cs; appliedDpi = $dpi } | ConvertTo-Json -Compress",
  ].join(" ");
  const stdout = execFileSync("powershell", ["-NoProfile", "-Command", psCommand], { encoding: "utf8" });
  envPs = JSON.parse(stdout);
} catch (error) {
  fail(`PowerShell 环境采集失败: ${error.message}`);
}
const appliedDpi = Number(envPs.appliedDpi);
const environment = {
  os: envPs.os,
  system: envPs.system,
  gpus: envPs.gpus,
  dpi: {
    appliedDpi,
    scalePercent: Math.round((appliedDpi / 96) * 100),
    note: "HKCU WindowMetrics AppliedDPI（主显示器系统级缩放；per-monitor v2 各屏差异未逐一枚举）",
  },
  memoryKB: {
    total: envPs.os.TotalVisibleMemorySize,
    free: envPs.os.FreePhysicalMemory,
  },
  wgpuAdapters: raw.adapters,
  runtime: {
    harness: "scripts/p03-04-device-matrix/harness (镜像 bin 侧 deep2d_gpu 闭包，生产源码未改动)",
    wgpu: "30.0.1 (dx12+vulkan+wgsl)",
  },
};

// ---------- 5. Chrome WebGPU 强制后端探测（适配器级，非渲染格） ----------
step("probe Chrome WebGPU forced backends");
const pnpmRoot = resolve(repo, "node_modules/.pnpm");
let webgpuProbe = { attempted: false };
if (existsSync(chromePath)) {
  try {
    const pwDirName = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright-core@"));
    if (!pwDirName) throw new Error("node_modules/.pnpm 下未找到 playwright-core");
    const { chromium } = await import(
      pathToFileURL(join(pnpmRoot, pwDirName, "node_modules/playwright-core/index.mjs")).href
    );
    // navigator.gpu 仅在安全上下文暴露；localhost 属安全上下文，data:/about: 不是。
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>p03-04</title>");
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const forced = {};
    try {
      for (const backend of ["vulkan", "d3d11", "d3d12"]) {
        const browser = await chromium.launch({
          executablePath: chromePath,
          headless: true,
          args: ["--enable-unsafe-webgpu", `--use-webgpu-adapter=${backend}`],
        });
        try {
          const page = await browser.newPage();
          await page.goto(baseUrl, { waitUntil: "load" });
          forced[backend] = await page.evaluate(async () => {
            if (!navigator.gpu) return { available: false, reason: "navigator.gpu undefined" };
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return { available: false, reason: "requestAdapter returned null" };
            const info = adapter.info ?? {};
            return {
              available: true,
              adapter: {
                vendor: info.vendor,
                architecture: info.architecture,
                device: info.device,
                description: info.description,
                isFallbackAdapter: adapter.isFallbackAdapter,
              },
            };
          });
        } finally {
          await browser.close();
        }
      }
    } finally {
      server.close();
    }
    const backends = Object.entries(forced)
      .filter(([, result]) => result.available)
      .map(([backend, result]) => `${backend}:${result.adapter.vendor}/${result.adapter.architecture}`);
    webgpuProbe = {
      attempted: true,
      chrome: chromePath,
      forced,
      feasible:
        new Set(backends.map((entry) => entry.split(":")[0])).size > 1
          ? "多后端可切换（适配器级探测成功）——本切片未包含浏览器渲染格，理由见 notEnumerated"
          : "仅适配器级探测；浏览器渲染格未包含（见 notEnumerated）",
    };
  } catch (error) {
    webgpuProbe = { attempted: true, error: error.message };
  }
} else {
  webgpuProbe = { attempted: false, reason: `Chrome 不存在: ${chromePath}` };
}

// ---------- 6. 验收门禁（诚实记录，不硬凑通过） ----------
step("evaluate acceptance gates");
const gates = [];
for (const cell of raw.cells) {
  const letterbox = cell.letterbox;
  if (letterbox.barViolations > 0)
    gates.push({ gate: `FAIL ${cell.id}: letterbox bar 区存在 ${letterbox.barViolations}/${letterbox.barPixelsTotal} 个非清屏像素` });
  else if (!cell.validationClean) gates.push({ gate: `FAIL ${cell.id}: GPU validation error` });
  for (const layer of cell.clippedLayers) {
    if (!layer.landed)
      gates.push({ gate: `FAIL ${cell.id}: 被裁剪图层 ${layer.id} 在物理尺寸未落像素` });
  }
}
for (const cell of raw.fontCells) {
  if (cell.coloredPixels < 100) gates.push({ gate: `FAIL ${cell.id}: 文字墨迹不足 (${cell.coloredPixels}px)` });
}
for (const [label, result] of Object.entries(raw.deviceLoss)) {
  if (!result.redrawEqualsBefore)
    gates.push({ gate: `WARN ${label}: destroy→重建后重绘与销毁前存在差异 (${JSON.stringify(result.diff)})` });
  if (!result.redrawStableAcrossRepeat)
    gates.push({ gate: `FAIL ${label}: 重建后两次重绘不自一致` });
}
const backendDiffRatio = raw.backendDiff.diffPixels / raw.backendDiff.totalPixels;
const packageSha = createHash("sha256").update(readFileSync(packagePath)).digest("hex");

// ---------- 7. matrix.json ----------
const matrix = {
  task: "P3-04",
  slice: "Windows 设备/驱动能力矩阵 —— 单机可执行版（覆盖本机可枚举维度）",
  generatedAtEpochSecs: raw.generatedAtEpochSecs,
  package: { ...raw.package, sha256: packageSha },
  environment,
  results: {
    backendDimension: {
      cells: raw.cells.filter((cell) => cell.physical[0] === 960 && cell.physical[1] === 540),
      crossBackendDiff: raw.backendDiff,
      diffPixelRatio: backendDiffRatio,
    },
    sizeDpiDimension: {
      cells: raw.cells,
      sizeConsistency: raw.sizeConsistency,
      systemScalePercent: environment.dpi.scalePercent,
    },
    fontDimension: {
      cells: raw.fontCells,
      diff: raw.fontDiff,
      probes: raw.fontProbes,
      note: "读回 alpha 平面全帧统一为不透明（deep2d 呈现语义），文字墨迹以 coloredPixels（RGB 非零）为准；inkPixels 仅记录该平面",
    },
    deviceLossRecovery: raw.deviceLoss,
    webgpuBrowser: webgpuProbe,
  },
  gates,
  notEnumerated: [
    "多设备/多 GPU（双卡、外接 eGPU）不可枚举：本机仅一块 RTX 4060 Laptop，无法在同一矩阵内对比不同设备",
    "多驱动版本不可枚举：无法在单机上安装/切换多个 NVIDIA 驱动版本；驱动维度只记录当前指纹",
    "集成显卡（Intel/AMD iGPU）路径不可枚举：本机无 iGPU 参与 wgpu 适配器选择（BIOS 层混合输出未验证）",
    "远桌面/RDP/虚拟化 GPU（WARP 之外的）不可枚举：未在 RDP 会话下执行",
    "运行中驱动级设备丢失（TDR、驱动升级、禁用设备）不可注入：headless 唯一可靠注入是 device.destroy()，已按此执行",
    "浏览器 WebGPU 渲染格未包含：Chrome 可强制 Dawn 后端（适配器级探测已记录在 results.webgpuBrowser），但同内容跨 Dawn 后端像素 diff 需要浏览器侧 dashboard 运行时出帧，属 P0-08 跨端矩阵范畴，本切片不重复",
  ],
  files: { matrix: "matrix.json", environment: "environment.json", raw: "matrix_raw.json", png: pngFiles },
};
writeFileSync(join(output, "matrix.json"), JSON.stringify(matrix, null, 2));
writeFileSync(join(output, "environment.json"), JSON.stringify(environment, null, 2));

// ---------- 8. 摘要 ----------
const summary = {
  cells: raw.cells.length + raw.fontCells.length,
  backendDiff: `${raw.backendDiff.diffPixels}/${raw.backendDiff.totalPixels} (${(backendDiffRatio * 100).toFixed(4)}%) maxΔ=${raw.backendDiff.maxChannelDelta}`,
  gates: gates.length === 0 ? "全部通过" : gates.map((gate) => gate.gate),
  output,
};
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (gates.some((gate) => gate.gate.startsWith("FAIL"))) fail("存在 FAIL 级门禁，见 summary.json");
