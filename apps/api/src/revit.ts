import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RevitInstallationRecord, RevitRuntimeInfo } from "@bim-studio/contracts";
import type { CommandProviderConfig } from "./config.js";

const execFileAsync = promisify(execFile);

function versionOf(value: string): string | undefined {
  const match = value.match(/(?:^|\D)(20\d{2})(?:\D|$)/);
  return match?.[1];
}

function addInstallation(found: Map<string, RevitInstallationRecord>, version: string, executable: string, source: RevitInstallationRecord["source"]): void {
  const resolved = path.resolve(executable);
  if (!existsSync(resolved) || found.has(version)) return;
  const appData = process.env.APPDATA ?? "";
  const workerRoot = process.env.BIM_STUDIO_WORKER_ROOT ?? "";
  found.set(version, {
    version,
    path: resolved,
    source,
    addinInstalled: Boolean(appData) && existsSync(path.join(appData, "Autodesk", "Revit", "Addins", version, "BimStudio.RevitAddin.addin")),
    workerReady: Boolean(workerRoot) && existsSync(path.join(workerRoot, version, "ready.json"))
  });
}

async function registryInstallations(): Promise<Array<{ version: string; path: string }>> {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
  ];
  const result: Array<{ version: string; path: string }> = [];
  for (const root of roots) {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", root, "/s", "/f", "Autodesk Revit", "/d"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const blocks = stdout.split(/\r?\n(?=HKEY_)/);
      for (const block of blocks) {
        const displayName = block.match(/DisplayName\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
        const version = displayName ? versionOf(displayName) : undefined;
        const installLocation = block.match(/InstallLocation\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
        if (version && installLocation) result.push({ version, path: path.join(installLocation, "Revit.exe") });
      }
    } catch {
      // Registry discovery is optional; environment and standard paths remain available.
    }
  }
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", "HKLM\\SOFTWARE\\Autodesk\\Revit", "/s"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const blocks = stdout.split(/\r?\n(?=HKEY_)/);
    for (const block of blocks) {
      const productName = block.match(/ProductName\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
      const installationLocation = block.match(/InstallationLocation\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
      const version = productName ? versionOf(productName) : undefined;
      if (version && installationLocation) result.push({ version, path: path.join(installationLocation, "Revit.exe") });
    }
  } catch {
    // Older Revit releases may not create this product registry branch.
  }
  return result;
}

export async function discoverRevitInstallations(): Promise<RevitInstallationRecord[]> {
  const found = new Map<string, RevitInstallationRecord>();
  for (const [name, executable] of Object.entries(process.env)) {
    const match = name.match(/^REVIT_(20\d{2})_PATH$/i);
    if (match?.[1] && executable) addInstallation(found, match[1], executable, "environment");
  }
  const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((item): item is string => Boolean(item));
  for (let year = 2019; year <= new Date().getFullYear() + 2; year += 1) {
    for (const root of programFiles) addInstallation(found, String(year), path.join(root, "Autodesk", `Revit ${year}`, "Revit.exe"), "standard");
  }
  for (const installation of await registryInstallations()) addInstallation(found, installation.version, installation.path, "registry");
  return [...found.values()].sort((left, right) => Number(left.version) - Number(right.version));
}

export async function getRevitRuntimeInfo(): Promise<RevitRuntimeInfo> {
  const installations = await discoverRevitInstallations();
  const configured = process.env.RVT_REVIT_VERSION?.trim();
  return { installations, defaultVersion: configured && installations.some((item) => item.version === configured) ? configured : "auto" };
}

export function resolveRevitVersion(installations: RevitInstallationRecord[], requested: string | undefined, sourceVersion: string | undefined): string {
  if (installations.length === 0) throw new Error("没有检测到可用的 Revit，请先安装 Revit 和 Deep Monkey Studio Add-in");
  const installed = installations.map((item) => Number(item.version)).filter(Number.isFinite).sort((a, b) => a - b);
  const source = sourceVersion ? Number(sourceVersion) : undefined;
  if (requested && requested !== "auto") {
    const selected = Number(requested);
    if (!installed.includes(selected)) throw new Error(`Revit ${requested} 未安装或路径无效`);
    if (source && selected < source) throw new Error(`该文件由 Revit ${sourceVersion} 保存，不能使用 Revit ${requested} 打开`);
    return requested;
  }
  const configured = Number(process.env.RVT_REVIT_VERSION);
  if (!source && installed.includes(configured)) return String(configured);
  const compatible = source ? installed.find((version) => version >= source) : installed.at(-1);
  if (!compatible) throw new Error(`该文件需要 Revit ${sourceVersion} 或更高版本，当前最高仅安装 Revit ${installed.at(-1)}`);
  return String(compatible);
}

export async function inspectRvtVersion(provider: CommandProviderConfig, input: string): Promise<string | undefined> {
  if (!provider.command) return undefined;
  try {
    await access(provider.command);
    const { stdout } = await execFileAsync(provider.command, ["--inspect", input], { cwd: provider.cwd, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const payload = stdout.trim();
    if (!payload) return undefined;
    const result = JSON.parse(payload) as { sourceVersion?: string };
    return result.sourceVersion;
  } catch {
    return undefined;
  }
}
