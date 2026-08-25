import { spawn } from "node:child_process";
import type { ConverterProviderProbe } from "@bim-studio/contracts";

export type ParasolidProviderId = "cadexchanger-batch" | "hoops-exchange" | "datakit-crosscad";

export interface ParasolidProviderConfig {
  id: ParasolidProviderId;
  name: string;
  deployment: "server" | "desktop";
  command?: string;
  probeArgs: string[];
}

export type ParasolidProbeRunner = (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const providers: Record<ParasolidProviderId, { name: string; remediation: string }> = {
  "cadexchanger-batch": {
    name: "CAD Exchanger Batch adapter",
    remediation: "在唯一转换服务器购买并安装 CAD Exchanger Batch 的 Parasolid+glTF 许可，按随包文档构建签名 adapter，再把 PARASOLID_CONVERTER_COMMAND 指向 adapter；不要猜测厂商 CLI 参数。"
  },
  "hoops-exchange": {
    name: "HOOPS Exchange sidecar",
    remediation: "使用已授权 HOOPS Exchange SDK 构建并签名 bim-studio-parasolid-adapter，再将 PARASOLID_CONVERTER_COMMAND 指向该 sidecar。"
  },
  "datakit-crosscad": {
    name: "Datakit CrossCad/Ware sidecar",
    remediation: "使用已授权 Datakit CrossCad/Ware SDK 构建并签名 bim-studio-parasolid-adapter，再配置 PARASOLID_CONVERTER_COMMAND。"
  }
};

export function loadParasolidProviderConfig(environment: NodeJS.ProcessEnv = process.env): ParasolidProviderConfig {
  const requested = environment.PARASOLID_CONVERTER_PROVIDER?.trim() || "cadexchanger-batch";
  const id = isProviderId(requested) ? requested : "cadexchanger-batch";
  const command = environment.PARASOLID_CONVERTER_COMMAND?.trim() || undefined;
  return {
    id,
    name: providers[id].name,
    deployment: environment.PARASOLID_CONVERTER_DEPLOYMENT === "desktop" ? "desktop" : "server",
    ...(command ? { command } : {}),
    probeArgs: parseProbeArgs(environment.PARASOLID_CONVERTER_PROBE_ARGS)
  };
}

export async function probeParasolidProvider(
  config: ParasolidProviderConfig,
  runner: ParasolidProbeRunner = runProbe
): Promise<ConverterProviderProbe> {
  const base = {
    id: config.id,
    name: config.name,
    deployment: config.deployment,
    remediation: providers[config.id].remediation
  } as const;
  if (!config.command) {
    return { ...base, status: "not_configured", message: `已选择 ${config.name}，但尚未配置执行程序` };
  }
  try {
    const result = await runner(config.command, config.probeArgs);
    if (result.exitCode !== 0) {
      return {
        ...base,
        status: "probe_failed",
        command: config.command,
        message: `${config.name} 探针退出码 ${result.exitCode}：${firstLine(result.stderr) || "无错误输出"}`
      };
    }
    const detectedVersion = firstLine(result.stdout) || firstLine(result.stderr) || "版本未报告";
    return {
      ...base,
      status: "detected",
      command: config.command,
      detectedVersion,
      message: `已检测到 ${config.name}：${detectedVersion}`
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...base,
      status: code === "ENOENT" ? "not_found" : "probe_failed",
      command: config.command,
      message: code === "ENOENT" ? `${config.name} 执行程序不存在：${config.command}` : `${config.name} 探针失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export interface ParasolidHeaderInfo {
  encoding: "text" | "binary";
  signatureFound: boolean;
  schemaId?: string;
  majorVersion?: number;
}

/** Best-effort preflight only; the licensed provider remains authoritative. */
export function inspectParasolidHeader(bytes: Uint8Array, extension: "x_t" | "x_b"): ParasolidHeaderInfo {
  const sample = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
  const signatureFound = /PARASOLID/i.test(sample);
  const schemaId = sample.match(/\bSCH_(\d{4,6})\b/i)?.[1];
  const versionDigits = schemaId?.slice(0, -3);
  const majorVersion = versionDigits && /^\d+$/.test(versionDigits) ? Number(versionDigits) : undefined;
  return {
    encoding: extension === "x_t" ? "text" : "binary",
    signatureFound,
    ...(schemaId ? { schemaId } : {}),
    ...(majorVersion && majorVersion > 0 ? { majorVersion } : {})
  };
}

function isProviderId(value: string): value is ParasolidProviderId {
  return value === "cadexchanger-batch" || value === "hoops-exchange" || value === "datakit-crosscad";
}

function parseProbeArgs(value: string | undefined): string[] {
  if (!value?.trim()) return ["--probe", "--json"];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : ["--probe", "--json"];
  } catch {
    return ["--probe", "--json"];
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? "";
}

function runProbe(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("探针超过 5 秒"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode: exitCode ?? -1, stdout: stdout.slice(-8_000), stderr: stderr.slice(-8_000) });
    });
  });
}
