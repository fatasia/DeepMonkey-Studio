import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  ConversionArtifactKind,
  ConverterOutputDeclaration,
  ConverterPluginManifest,
  ConverterProviderProbe,
} from "@bim-studio/contracts";
import type { CommandProviderConfig } from "./config.js";
import type { ConverterExecutionContext, ConverterPluginRegistration } from "./conversionTasks.js";
import type { ObjectStore } from "./objects.js";
import { auditConverterOutput } from "./converterOutputAudit.js";

interface ConverterDefinition {
  id: string;
  name: string;
  inputFormats: string[];
  providerName: string;
  config: CommandProviderConfig;
  deployment: "server" | "desktop";
  requireHierarchy: boolean;
}

interface OutputFile {
  kind: ConversionArtifactKind;
  format: string;
  fileName: string;
  required: boolean;
}

const outputFiles: OutputFile[] = [
  { kind: "geometry", format: "glb", fileName: "geometry.glb", required: true },
  { kind: "hierarchy", format: "json", fileName: "hierarchy.json", required: false },
  { kind: "properties", format: "json", fileName: "properties.json", required: false },
  { kind: "pmi", format: "json", fileName: "pmi.json", required: false },
];

/**
 * 高价值原生格式统一走进程隔离适配层。SDK 与许可证不进入 API 主进程，
 * 未部署时仍能如实展示能力与修复方式，不把“已声明”伪装成“已可用”。
 */
export function createExternalConverterRegistrations(
  config: { rvt: CommandProviderConfig; industrialCad: CommandProviderConfig },
  objects: ObjectStore,
): ConverterPluginRegistration[] {
  const definitions: ConverterDefinition[] = [
    {
      id: "bim.revit-native",
      name: "Revit 原生高保真转换",
      inputFormats: ["rvt"],
      providerName: "Industrial Studio Revit Worker",
      config: config.rvt,
      deployment: "desktop",
      requireHierarchy: true,
    },
    {
      id: "industrial.parasolid-exchange",
      name: "Parasolid XT 工业转换",
      inputFormats: ["x_t", "x_b"],
      providerName: "工业 CAD SDK 适配器",
      config: config.industrialCad,
      deployment: "server",
      requireHierarchy: true,
    },
    {
      id: "industrial.jt-exchange",
      name: "JT 装配与 PMI 转换",
      inputFormats: ["jt"],
      providerName: "工业 CAD SDK 适配器",
      config: config.industrialCad,
      deployment: "server",
      requireHierarchy: true,
    },
  ];

  return definitions.map((definition) => createRegistration(definition, objects));
}

function createRegistration(
  definition: ConverterDefinition,
  objects: ObjectStore,
): ConverterPluginRegistration {
  const resolvedCommand = resolveConfiguredCommand(definition.config);
  const provider = createProviderProbe(definition, resolvedCommand);
  const manifest = createManifest(definition);
  if (!resolvedCommand) {
    return { manifest, provider, unavailableReason: provider.message };
  }
  return {
    manifest,
    provider,
    execute: (context) => executeExternalConverter(context, definition, resolvedCommand, objects),
  };
}

function createManifest(definition: ConverterDefinition): ConverterPluginManifest {
  const outputs: ConverterOutputDeclaration[] = outputFiles.map((output) => ({
    kind: output.kind,
    format: output.format,
    required: output.required || (definition.requireHierarchy && output.kind === "hierarchy"),
  }));
  return {
    contractVersion: 1,
    id: definition.id,
    name: definition.name,
    version: "1.0.0",
    execution: definition.deployment === "desktop" ? "desktop-sidecar" : "server-worker",
    inputFormats: definition.inputFormats,
    outputs,
    configurationSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        quality: { type: "string", enum: ["high", "balanced"], default: "high" },
        includePmi: { type: "boolean", default: true },
      },
    },
    capabilities: ["filesystem.read-input", "filesystem.write-output"],
    limits: {
      timeoutMs: 30 * 60 * 1_000,
      maxInputBytes: 2 * 1024 * 1024 * 1024,
      maxOutputBytes: 4 * 1024 * 1024 * 1024,
      maxMemoryMb: 16_384,
      maxCpuPercent: 100,
    },
  };
}

function createProviderProbe(
  definition: ConverterDefinition,
  resolvedCommand: string | undefined,
): ConverterProviderProbe {
  if (!definition.config.command) {
    return {
      id: definition.id,
      name: definition.providerName,
      deployment: definition.deployment,
      status: "not_configured",
      message: `${definition.providerName} 未配置`,
      remediation: definition.id === "bim.revit-native"
        ? "在已授权 Revit 的 Windows 机器配置 RVT_CONVERTER_COMMAND。"
        : "部署 HOOPS Exchange、CAD Exchanger 或 Siemens 组件适配器，并配置 INDUSTRIAL_CAD_CONVERTER_COMMAND。",
    };
  }
  if (!resolvedCommand) {
    return {
      id: definition.id,
      name: definition.providerName,
      deployment: definition.deployment,
      status: "not_found",
      command: path.basename(definition.config.command),
      message: `${definition.providerName} 命令不存在或不可执行`,
      remediation: "检查命令路径、服务账户权限和 SDK 许可证部署。",
    };
  }
  return {
    id: definition.id,
    name: definition.providerName,
    deployment: definition.deployment,
    status: "detected",
    command: path.basename(resolvedCommand),
    message: "转换器命令已检测；首次任务将验证格式与许可证",
    remediation: "用受控样本执行验收，确认装配树、属性、PMI 和几何指纹。",
  };
}

async function executeExternalConverter(
  context: ConverterExecutionContext,
  definition: ConverterDefinition,
  command: string,
  objects: ObjectStore,
): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "bim-cad-converter-"));
  const inputPath = path.join(workDir, context.task.input.fileName);
  const outputDir = path.join(workDir, "output");
  try {
    await mkdir(outputDir, { recursive: true });
    context.reportProgress(5, "正在读取项目源文件");
    const source = await objects.read(context.task.input.objectKey);
    await pipeline(source.stream, createWriteStream(inputPath, { flags: "wx" }));
    await source.completed;
    const options = normalizeTaskOptions(context.task.configuration);
    const args = definition.config.args.map((argument) => replaceArgument(argument, {
      input: inputPath,
      output: outputDir,
      format: context.task.input.format,
      quality: options.quality,
      includePmi: String(options.includePmi),
    }));
    context.reportProgress(20, "正在执行隔离转换器");
    await runCommand(command, args, definition.config.cwd, context.signal, context.task.id, context.task.input.fileName);
    context.reportProgress(85, "正在校验并发布转换产物");
    await publishOutputFiles(context, objects, outputDir, definition.requireHierarchy);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function normalizeTaskOptions(configuration: Record<string, unknown>): { quality: "high" | "balanced"; includePmi: boolean } {
  const unknown = Object.keys(configuration).filter((key) => key !== "quality" && key !== "includePmi");
  if (unknown.length > 0) throw new Error(`不支持的转换配置：${unknown.join(", ")}`);
  const quality = configuration.quality ?? "high";
  const includePmi = configuration.includePmi ?? true;
  if (quality !== "high" && quality !== "balanced") throw new Error("quality 必须是 high 或 balanced");
  if (typeof includePmi !== "boolean") throw new Error("includePmi 必须是布尔值");
  return { quality, includePmi };
}

async function publishOutputFiles(
  context: ConverterExecutionContext,
  objects: ObjectStore,
  outputDir: string,
  requireHierarchy: boolean,
): Promise<void> {
  const audit = await auditConverterOutput(outputDir, requireHierarchy);
  const produced = new Set(audit.files);
  for (const output of outputFiles) {
    if (!produced.has(output.fileName)) continue;
    const filePath = path.join(outputDir, output.fileName);
    const objectKey = `${context.outputPrefix}${output.fileName}`;
    const fileStat = await stat(filePath);
    await objects.putFile(objectKey, filePath);
    context.publishArtifact({
      kind: output.kind,
      format: output.format,
      objectKey,
      size: fileStat.size,
      sha256: await sha256(filePath),
      ...(output.kind === "geometry" ? { metadata: { ...audit.geometry } } : {}),
    });
  }
  context.reportProgress(99, "产物已发布，正在完成一致性校验");
}

function replaceArgument(argument: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), argument);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  taskId: string,
  inputName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      child.kill();
      finish(new Error("转换任务已取消"));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("转换器执行超时"));
    }, 30 * 60 * 1_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0
      ? undefined
      : new Error(`转换器退出码 ${String(code)}（任务 ${taskId}，输入 ${inputName}）：${stderr.trim() || "无错误输出"}`)));
  });
}

function resolveConfiguredCommand(config: CommandProviderConfig): string | undefined {
  const command = config.command;
  if (!command) return undefined;
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = path.resolve(config.cwd, command);
    return existsSync(candidate) ? candidate : undefined;
  }
  const extensions = process.platform === "win32"
    ? (path.extname(command) ? [""] : (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";"))
    : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === "win32" ? `${command}${extension.toLowerCase()}` : command);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
