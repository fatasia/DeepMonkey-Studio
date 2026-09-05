import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// 文件上限由 check-source-size 阻断；此审计补充职责候选，不能把长 JSX/测试函数自动判为缺陷。
const ignored = ["node_modules", "dist", "target", "coverage", ".scene-viewer-build", ".smoke-runs", "Library", "PackageCache", "site-packages"];
const paths = execFileSync("rg", ["--files", "--hidden", "--no-ignore", "apps", "packages", "scripts", "tools", ...ignored.flatMap(folder => ["--glob", `!**/${folder}/**`])], { encoding: "utf8" }).trim().split(/\r?\n/);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".rs", ".cs", ".py", ".ps1"]);
const oversizedFiles = [], functions = [];
let scannedFiles = 0, parsedFiles = 0;
for (const file of paths) {
  const extension = path.extname(file);
  if (!sourceExtensions.has(extension)) continue;
  const source = readFileSync(file, "utf8");
  scannedFiles += 1;
  const lines = source.split(/\r?\n/).length - Number(source.endsWith("\n"));
  if (lines > 500) oversizedFiles.push({ file: file.replaceAll("\\", "/"), lines, blocking: lines > 800 });
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension) || /\.d\.ts$/.test(file)) continue;
  parsedFiles += 1;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, extension.endsWith("x") ? ts.ScriptKind.TSX : extension.includes("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.body) {
      const start = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      const end = parsed.getLineAndCharacterOfPosition(node.end).line + 1;
      if (end - start + 1 > 80) functions.push({ file: file.replaceAll("\\", "/"), start, lines: end - start + 1, name: node.name?.getText(parsed) ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(parsed) : "callback"), testOrTool: /[\\/](scripts|tools)[\\/]|\.test\./.test(file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}
oversizedFiles.sort((a, b) => b.lines - a.lines);
functions.sort((a, b) => b.lines - a.lines);
const output = path.resolve("test-output/codex-2026-09-05/source-structure");
mkdirSync(output, { recursive: true });
const report = { createdAt: new Date().toISOString(), scannedFiles, parsedFiles, boundary: "All listed source file sizes; TS/JS AST function spans only. Long JSX and tests need ownership review, not mechanical splitting. Rust/C#/Python function bodies not parsed.", oversizedFiles, functions };
writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, scannedFiles, parsedFiles, filesOver500: oversizedFiles.length, filesOver800: oversizedFiles.filter(f => f.blocking).length, functionsOver80: functions.length, productionFunctionsOver80: functions.filter(f => !f.testOrTool).length, largestProductionFunctions: functions.filter(f => !f.testOrTool).slice(0, 16) }, null, 2));
