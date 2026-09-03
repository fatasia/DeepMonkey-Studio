import type { ApplicationScriptDependency, ScriptModule } from "@bim-studio/contracts";

export type ScriptDependencyInstallMode = "npm" | "upload" | "external-url";

export interface ScriptDependencyDraft {
  mode: ScriptDependencyInstallMode;
  specifier: string;
  packageName: string;
  version: string;
  url: string;
  file?: Pick<File, "name" | "size">;
}

const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const specifierPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export function validateDependencyDraft(draft: ScriptDependencyDraft): string | undefined {
  if (!specifierPattern.test(draft.specifier.trim())) return "模块名需使用 npm 风格，例如 dayjs 或 @scope/pkg";
  if (draft.mode === "npm") {
    if (!specifierPattern.test(draft.packageName.trim())) return "请填写有效的 npm 包名";
    if (!exactVersionPattern.test(draft.version.trim())) return "必须填写固定版本，例如 1.2.3";
  }
  if (draft.mode === "external-url") {
    try {
      const protocol = new URL(draft.url.trim()).protocol;
      if (protocol !== "https:" && protocol !== "http:") return "外部地址只支持 HTTP 或 HTTPS";
    } catch {
      return "请填写完整的外部 JS 地址";
    }
  }
  if (draft.mode === "upload") {
    if (!draft.file) return "请选择要本地化的 JavaScript 文件";
    if (!/\.(?:js|mjs)$/i.test(draft.file.name)) return "仅支持 .js 或 .mjs 文件";
    if (draft.file.size <= 0) return "不能上传空文件";
    if (draft.file.size > MAX_UPLOAD_BYTES) return "JavaScript 文件不能超过 4 MB";
  }
  return undefined;
}

export interface ScriptDependencyReference {
  id: string;
  name: string;
}

/**
 * 依赖删除采用保守策略：只要脚本含静态 import/export、动态 import 或 require，
 * 都视为引用。极少量注释中的同名语句会导致多拦一次，但不会误删生产依赖。
 */
export function findDependencyReferences(
  scripts: readonly Pick<ScriptModule, "id" | "name" | "code">[],
  specifier: string,
): ScriptDependencyReference[] {
  const escaped = escapeRegExp(specifier);
  const quoted = `["']${escaped}["']`;
  const patterns = [
    new RegExp(`\\bimport\\s*(?:\\(\\s*)?${quoted}`, "m"),
    new RegExp(`\\b(?:import|export)\\s+[^;]{0,500}?\\bfrom\\s*${quoted}`, "m"),
    new RegExp(`\\brequire\\s*\\(\\s*${quoted}`, "m"),
  ];
  return scripts
    .filter((script) => patterns.some((pattern) => pattern.test(script.code)))
    .map(({ id, name }) => ({ id, name }));
}

export function dependencyImportSnippet(specifier: string): string {
  return `import * as ${moduleIdentifier(specifier)} from ${JSON.stringify(specifier)};\n`;
}

export function dependencySourceLabel(source: ApplicationScriptDependency["source"]): string {
  if (source === "npm") return "npm 锁定";
  if (source === "upload") return "本地上传";
  return "外链缓存";
}

export function formatDependencyBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KB`;
  return `${trimDecimal(bytes / 1024 / 1024)} MB`;
}

export function shortIntegrity(integrity: string): string {
  const value = integrity.replace(/^sha256-/, "");
  return value.length > 15 ? `sha256-${value.slice(0, 8)}…${value.slice(-6)}` : integrity;
}

export function parseNpmRequest(requested: string, resolvedVersion?: string): { packageName: string; version: string } {
  const splitAt = requested.lastIndexOf("@");
  if (splitAt > 0) return { packageName: requested.slice(0, splitAt), version: requested.slice(splitAt + 1) };
  return { packageName: requested, version: resolvedVersion ?? "" };
}

function moduleIdentifier(specifier: string): string {
  const source = specifier.split("/").at(-1) ?? "dependency";
  const words = source.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  let identifier = words.map((word, index) => index ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word).join("");
  if (!identifier || !/^[A-Za-z_$]/.test(identifier)) identifier = `dependency${identifier}`;
  if (reservedWords.has(identifier)) identifier = `${identifier}Module`;
  return identifier;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

const reservedWords = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);
