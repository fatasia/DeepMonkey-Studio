import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const tauriRoot = path.join(desktopRoot, "src-tauri");
const releaseRoot = path.join(tauriRoot, "target", "release");
const wixWorkspace = path.join(releaseRoot, "wix", "x64");
const configPath = path.join(tauriRoot, "tauri.conf.json");
const verifyScript = path.join(desktopRoot, "scripts", "verify-bundle.mjs");
const tauriCommand = path.join(desktopRoot, "node_modules", ".bin", process.platform === "win32" ? "tauri.CMD" : "tauri");
const startedAt = Date.now();

const build = spawnSync(tauriCommand, ["build"], {
  cwd: desktopRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (build.status !== 0) {
  if (process.platform !== "win32" || !recoverWindowsMsi()) process.exit(build.status ?? 1);
}

const verify = spawnSync(process.execPath, [verifyScript], { cwd: desktopRoot, stdio: "inherit" });
process.exit(verify.status ?? 1);

function recoverWindowsMsi() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const nsisArtifact = path.join(releaseRoot, "bundle", "nsis", `${config.productName}_${config.version}_x64-setup.exe`);
  const mainWxs = path.join(wixWorkspace, "main.wxs");
  const localeWxl = path.join(wixWorkspace, "locale.wxl");
  const desktopExecutable = path.join(releaseRoot, "bim-studio-desktop.exe");
  const generatedThisRun = [nsisArtifact, mainWxs, localeWxl, desktopExecutable]
    .every((candidate) => existsSync(candidate) && statSync(candidate).mtimeMs >= startedAt - 2_000);
  if (!generatedThisRun) return false;

  const wixTools = findWixTools();
  if (!wixTools) return false;
  console.warn("[desktop-bundle] Windows Installer 校验服务不可用；使用本次 WiX 源跳过 ICE 校验并重新链接 MSI。");
  const candle = spawnSync(path.join(wixTools, "candle.exe"), [
    "-arch", "x64", mainWxs, `-dSourceDir=${desktopExecutable}`,
  ], { cwd: wixWorkspace, stdio: "inherit" });
  if (candle.status !== 0) return false;

  const outputMsi = path.join(wixWorkspace, "output.msi");
  const light = spawnSync(path.join(wixTools, "light.exe"), [
    "-sval",
    "-ext", path.join(wixTools, "WixUIExtension.dll"),
    "-ext", path.join(wixTools, "WixUtilExtension.dll"),
    "-o", outputMsi,
    "-cultures:zh-cn;en-US",
    "-loc", localeWxl,
    path.join(wixWorkspace, "main.wixobj"),
  ], { cwd: wixWorkspace, stdio: "inherit" });
  if (light.status !== 0 || !existsSync(outputMsi)) return false;

  const language = config.bundle?.windows?.wix?.language ?? "zh-CN";
  const msiDirectory = path.join(releaseRoot, "bundle", "msi");
  mkdirSync(msiDirectory, { recursive: true });
  copyFileSync(outputMsi, path.join(msiDirectory, `${config.productName}_${config.version}_x64_${language}.msi`));
  return true;
}

function findWixTools() {
  const tauriCache = path.join(process.env.LOCALAPPDATA ?? "", "tauri");
  if (!existsSync(tauriCache)) return undefined;
  return readdirSync(tauriCache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("WixTools"))
    .map((entry) => path.join(tauriCache, entry.name))
    .find((candidate) => ["candle.exe", "light.exe", "WixUIExtension.dll", "WixUtilExtension.dll"]
      .every((file) => existsSync(path.join(candidate, file))));
}
