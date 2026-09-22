import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProductionEnvironment } from "./nativeProductionOps.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 部署仍复用已经验收的 systemd / Windows 计划任务适配器，
 * 但用户只接触 pnpm studio，避免本地与部署各记一组入口。
 */
export function deploymentInvocation(action, options, platform = process.platform) {
  if (!new Set(["deploy", "undeploy"]).has(action)) throw new Error(`不支持的部署操作：${action}`);
  if (platform === "win32") {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(repositoryRoot, "scripts", "deploy-cloud.ps1")];
    if (action === "undeploy") args.push("-Stop");
    else {
      if (options.deploymentCheck) args.push("-Check");
      if (options.skipBuild) args.push("-SkipBuild");
    }
    return { command: "powershell.exe", args };
  }
  if (platform === "linux") {
    const args = [join(repositoryRoot, "scripts", "deploy-cloud.sh")];
    if (action === "undeploy") args.push("--stop");
    else {
      if (options.deploymentCheck) args.push("--check");
      if (options.skipBuild) args.push("--skip-build");
    }
    return { command: "bash", args };
  }
  throw new Error("生产部署入口当前支持 Windows 与 Linux");
}

export function runStudioDeployment(action, options, platform = process.platform) {
  const invocation = deploymentInvocation(action, options, platform);
  const productionEnvironment = loadProductionEnvironment().values;
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: productionEnvironment,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`生产部署操作失败（退出码 ${result.status ?? "unknown"}）`);
}

/** 无开发态状态文件时，统一入口继续识别由 deploy 管理的生产服务。 */
export async function getStudioDeploymentStatus(platform = process.platform, environmentPath) {
  const { values } = loadProductionEnvironment(environmentPath);
  const port = validPort(values.API_PORT, 4100);
  const origin = `http://127.0.0.1:${port}`;
  const healthy = await probeProductionApi(origin);
  const managed = productionDaemonIsActive(platform);
  return { kind: "production", running: managed || healthy, healthy, managed, origin };
}

export function printStudioDeploymentStatus(status) {
  if (!status.running) {
    process.stdout.write("\nDeepMonkey Studio：未运行\n\n");
    return;
  }
  process.stdout.write(`\nDeepMonkey Studio 生产服务\n  状态      ${status.healthy ? "健康" : "异常"}\n  守护      ${status.managed ? "已托管" : "未检测到守护进程"}\n  API       ${status.healthy ? "正常" : "异常"} · ${status.origin}\n\n`);
}

export function productionServiceName(platform = process.platform) {
  const rootHash = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 8);
  return platform === "win32" ? `DeepMonkeyStudioServer-${rootHash}` : `deep-monkey-studio-${rootHash}`;
}

async function probeProductionApi(origin) {
  try {
    const response = await fetch(`${origin}/api/meta`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const meta = await response.json();
    return meta?.apiVersion === "1.0" && Array.isArray(meta?.capabilities?.applications?.schemaVersions);
  } catch { return false; }
}

function productionDaemonIsActive(platform) {
  if (platform === "win32") {
    const task = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `if (Get-ScheduledTask -TaskName '${productionServiceName(platform)}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
    ], { windowsHide: true, stdio: "ignore" });
    if (task.status === 0) return true;
    const pidFile = join(repositoryRoot, ".runtime", "production.pid");
    if (!existsSync(pidFile)) return false;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  if (platform === "linux") {
    return spawnSync("systemctl", ["is-active", "--quiet", productionServiceName(platform)], { stdio: "ignore" }).status === 0;
  }
  return false;
}

function validPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}
