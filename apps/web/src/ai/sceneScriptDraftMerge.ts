import type { ApplicationScriptLifecycle } from "@bim-studio/contracts";

export interface SceneScriptDraftDiff {
  summary: string;
  addedLines: number;
  removedLines: number;
  preview: string[];
  declarationsAdded: string[];
}

/** 只向标准函数式生命周期插入语句；无法定位时拒绝猜测代码边界。 */
export function mergeSceneScriptLifecycle(
  code: string,
  lifecycle: ApplicationScriptLifecycle,
  lines: string[],
): { code?: string; error?: string } {
  const searchable = maskCommentsAndStrings(code);
  const functionPattern = new RegExp(`\\b(?:async\\s+)?function\\s+${lifecycle}\\s*\\([^)]*\\)\\s*\\{`);
  const match = functionPattern.exec(searchable);
  if (!match) {
    const expressionPattern = new RegExp(`\\b(?:const|let|var)\\s+${lifecycle}\\s*=`);
    if (expressionPattern.test(searchable)) return { error: `${lifecycle} 使用表达式声明，当前无法安全定位函数体` };
    return { code: `${code.trimEnd()}${code.trim() ? "\n\n" : ""}${sceneScriptLifecycleFragment(lifecycle, lines)}\n` };
  }
  const opening = (match.index ?? 0) + match[0].lastIndexOf("{");
  const closing = matchingBrace(code, opening);
  if (closing < 0) return { error: `${lifecycle} 的函数括号不完整` };
  const indentation = `${lineIndent(code, opening)}  `;
  const insertion = `\n${lines.map((line) => `${indentation}${line}`).join("\n")}`;
  return { code: `${code.slice(0, closing)}${insertion}\n${lineIndent(code, opening)}${code.slice(closing)}` };
}

export function sceneScriptLifecycleFragment(lifecycle: ApplicationScriptLifecycle, lines: string[]): string {
  return `function ${lifecycle}(ctx) {\n${lines.map((line) => `  ${line}`).join("\n")}\n}`;
}

export function buildSceneScriptDiff(before: string, after: string, declarationsAdded: string[]): SceneScriptDraftDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (beforeLines[prefix] === afterLines[prefix] && prefix < beforeLines.length && prefix < afterLines.length) prefix += 1;
  let suffix = 0;
  while (beforeLines.at(-1 - suffix) === afterLines.at(-1 - suffix) && suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix) suffix += 1;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  return {
    summary: `代码新增 ${added.length} 行、移除 ${removed.length} 行；声明新增 ${declarationsAdded.length} 项`,
    addedLines: added.length,
    removedLines: removed.length,
    preview: added.filter((line) => line.trim()).slice(0, 12),
    declarationsAdded,
  };
}

function matchingBrace(source: string, opening: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/** 遮蔽注释和字符串但保留字符位置，防止把示例文本误认成可编辑生命周期。 */
function maskCommentsAndStrings(source: string): string {
  const output = [...source];
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    const next = output[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { output[index] = " "; output[index + 1] = " "; blockComment = false; index += 1; }
      else if (char !== "\n") output[index] = " ";
      continue;
    }
    if (quote) {
      if (char !== "\n") output[index] = " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") { output[index] = " "; output[index + 1] = " "; lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { output[index] = " "; output[index + 1] = " "; blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { output[index] = " "; quote = char; }
  }
  return output.join("");
}

function splitLines(source: string): string[] {
  return source ? source.split(/\r?\n/) : [];
}

function lineIndent(source: string, offset: number): string {
  return source.slice(source.lastIndexOf("\n", offset) + 1, offset).match(/^\s*/)?.[0] ?? "";
}
