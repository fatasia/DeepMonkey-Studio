import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = argument("--input");
const output = argument("--output");
const requestedFormat = (argument("--format") ?? process.env.RVT_EXPORT_FORMAT ?? "ifc").toLowerCase();
const requestedRevitVersion = argument("--revit-version") ?? process.env.RVT_REVIT_VERSION;
const executable = process.env.REVIT_BATCH_PROCESSOR_PATH;
if (!input || !output) throw new Error("用法：node agent.mjs --input model.rvt --output output-dir");
if (!["ifc", "fbx"].includes(requestedFormat)) {
  throw new Error("内置 Revit Agent 仅支持 ifc 或 fbx；GLB 请配置 Leia 派生转换命令");
}
if (requestedRevitVersion && !/^20\d{2}$/.test(requestedRevitVersion)) {
  throw new Error("RVT_REVIT_VERSION 必须是四位 Revit 版本号，例如 2023 或 2026");
}
if (!executable || !existsSync(executable)) {
  throw new Error("REVIT_BATCH_PROCESSOR_PATH 未配置或文件不存在");
}
const inputPath = resolve(input);
const outputPath = resolve(output);
mkdirSync(outputPath, { recursive: true });
const fileList = join(outputPath, "rvt-files.txt");
writeFileSync(fileList, `${inputPath}\r\n`, "utf8");
const here = dirname(fileURLToPath(import.meta.url));
const taskScript = join(here, requestedFormat === "fbx" ? "export_fbx.py" : "export_ifc.py");
const args = [
  "--file_list", fileList,
  "--task_script", taskScript,
  ...(requestedRevitVersion ? ["--revit_version", requestedRevitVersion] : []),
  "--detach", "--worksets", "close_all"
];

const batchOutput = await new Promise((resolvePromise, reject) => {
  const child = spawn(executable, args, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BIM_STUDIO_OUTPUT_DIR: outputPath }
  });
  let outputText = "";
  const append = (chunk) => {
    outputText += chunk.toString();
    if (outputText.length > 16_000) outputText = outputText.slice(-16_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) resolvePromise(outputText);
    else reject(new Error(`Revit Batch Processor 退出码 ${String(code)}：\n${outputText.trim()}`));
  });
});

const result = join(outputPath, `model.${requestedFormat}`);
if (!existsSync(result)) {
  throw new Error(`Revit 已退出，但未生成 ${result}。\n${batchOutput.trim()}`);
}
