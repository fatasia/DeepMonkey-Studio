import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

async function distArtifacts(directory, prefix = "") {
  const files = new Set();
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const file of await distArtifacts(directory, relative)) files.add(file);
    } else if (entry.isFile()) files.add(relative);
  }
  return files;
}

/** Reproduce tsc's JS and declaration emission in memory; never clean or write a shared dist. */
export async function checkTsDistFreshness(repoRoot, packageName) {
  const packageRoot = path.join(repoRoot, "packages", packageName);
  const configPath = path.join(packageRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot, undefined, configPath);
  if (parsed.errors.length || !parsed.fileNames.length) {
    throw new Error(`${packageName} tsconfig 无有效源文件: ${parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`);
  }
  const dist = path.join(packageRoot, "dist");
  const expected = new Map();
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(`${packageName} 内存编译失败: ${diagnostics.slice(0, 3).map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`);
  const result = program.emit(undefined, (file, text) => {
    const relative = path.relative(dist, file).replaceAll("\\", "/");
    if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(`${packageName} 编译输出不在 dist 内: ${file}`);
    }
    expected.set(relative, Buffer.from(text));
  });
  if (result.emitSkipped || result.diagnostics.length || expected.size === 0) {
    throw new Error(`${packageName} 内存编译失败: ${result.diagnostics.slice(0, 3).map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`);
  }
  const stale = [];
  const hint = `pnpm --filter @bim-studio/${packageName} build`;
  const actual = await distArtifacts(dist).catch(error => {
    if (error.code === "ENOENT") return new Set();
    throw error;
  });
  for (const [file, bytes] of expected) {
    if (!actual.has(file)) {
      stale.push({ artifact: `${packageName} dist`, field: `缺少 ${file}`, hint });
      continue;
    }
    const disk = await readFile(path.join(dist, file));
    if (!bytes.equals(disk)) stale.push({ artifact: `${packageName} dist`, field: `内容不匹配 ${file}`, hint });
  }
  for (const file of actual) {
    if (!expected.has(file)) stale.push({ artifact: `${packageName} dist`, field: `多余 ${file}`, hint });
  }
  return { stale, emitted: expected.size };
}
