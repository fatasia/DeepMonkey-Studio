import type { DeepAssetPackage } from "./assetPackage.js";
import { validateDeepAssetPackage } from "./assetPackageValidation.js";
import { DEEP_RUNTIME_PACKAGE_SCHEMA, type DeepRuntimePackage } from "./runtimePackage/types.js";
import { validateDeepRuntimePackage } from "./runtimePackage/validation.js";

const FORBIDDEN_WEB_GL = String.fromCharCode(119, 101, 98, 103, 108);

export const DEEP_PACKAGE_PURITY_LIMITS = Object.freeze({
  maxNodes: 500_000, maxDepth: 32, maxIssues: 256,
  maxChunkBytes: 256 * 1024 * 1024, maxTotalChunkBytes: 2 * 1024 * 1024 * 1024,
});

export type DeepPackagePurityIssueCode = "package-invalid" | "budget-exceeded" | "chunk-budget-exceeded"
  | "chunk-metadata-invalid" | "path-obfuscation" | "forbidden-unity-runtime" | "forbidden-unity-web-data"
  | "forbidden-webgl" | "forbidden-webview-runtime" | "forbidden-browser-runtime"
  | "forbidden-script-runtime" | "forbidden-wasm-runtime";
export interface DeepPackagePurityIssue {
  readonly code: DeepPackagePurityIssueCode;
  readonly path: string;
  readonly message: string;
}
export interface DeepPackagePurityEvidence {
  readonly visitedNodes: number;
  readonly inspectedStrings: number;
  readonly inspectedChunks: number;
  readonly truncated: boolean;
}
export interface DeepPackagePurityResult {
  readonly clean: boolean;
  readonly packageKind: "asset" | "runtime" | "unknown";
  readonly issues: readonly DeepPackagePurityIssue[];
  readonly evidence: DeepPackagePurityEvidence;
}
export interface DeepPackagePurityOptions {
  /** Test/host may lower, never raise, the fixed work budget. */
  readonly maxNodes?: number;
  readonly maxIssues?: number;
}

interface AuditState {
  readonly issues: DeepPackagePurityIssue[];
  readonly seen: WeakSet<object>;
  readonly dedupe: Set<string>;
  readonly maxNodes: number;
  readonly maxIssues: number;
  nodes: number;
  strings: number;
  chunks: number;
  truncated: boolean;
}

/** Auto-detects and audits one package without filesystem, network, DOM, or executable inspection. */
export function auditDeepPackagePurity(input: unknown, options: DeepPackagePurityOptions = {}): DeepPackagePurityResult {
  const kind = packageKind(input);
  if (kind === "asset") return auditDeepAssetPackagePurity(input, options);
  if (kind === "runtime") return auditDeepRuntimePackagePurity(input, options);
  const state = createState(options);
  add(state, "package-invalid", "$", "Unknown Deep package schema."); walk(input, "$", "", state, 0);
  return finish("unknown", state);
}

export function auditDeepAssetPackagePurity(input: unknown,
  options: DeepPackagePurityOptions = {}): DeepPackagePurityResult {
  const state = createState(options), validation = validateDeepAssetPackage(input);
  for (const issue of validation.issues) add(state, "package-invalid", issue.path, `${issue.code}: ${issue.message}`);
  const value = validation.value ?? input;
  walk(value, "$", "", state, 0);
  if (validation.value) auditAssetChunks(validation.value, state);
  return finish("asset", state);
}

export function auditDeepRuntimePackagePurity(input: unknown,
  options: DeepPackagePurityOptions = {}): DeepPackagePurityResult {
  const state = createState(options), validation = validateDeepRuntimePackage(input);
  for (const issue of validation.issues) add(state, "package-invalid", issue.path, issue.message);
  walk(validation.valid ? validation.value : input, "$", "", state, 0);
  return finish("runtime", state);
}

function walk(value: unknown, path: string, key: string, state: AuditState, depth: number): void {
  if (state.truncated) return;
  if (++state.nodes > state.maxNodes || depth > DEEP_PACKAGE_PURITY_LIMITS.maxDepth) {
    state.truncated = true; add(state, "budget-exceeded", path, "Package purity traversal budget exceeded."); return;
  }
  if (typeof value === "string") {
    if (metadataKey(key)) inspect(value, path, key, state);
    return;
  }
  if (!value || typeof value !== "object" || state.seen.has(value)) return;
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (skipPayload(key)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length && !state.truncated; index++) {
      const descriptor = descriptors[String(index)];
      if (descriptor && "value" in descriptor) walk(descriptor.value, `${path}[${index}]`, key, state, depth + 1);
    }
    return;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[name]!;
    if (!("value" in descriptor) || (skipPayload(name) && typeof descriptor.value !== "object")) continue;
    const childPath = propertyPath(path, name);
    if (chunkKey(name)) auditChunkContainer(descriptor.value, childPath, state);
    walk(descriptor.value, childPath, name, state, depth + 1);
    if (state.truncated) return;
  }
}

function inspect(value: string, path: string, key: string, state: AuditState): void {
  state.strings++;
  const pathLike = /path|uri|url|file|name/i.test(key), decoded = decodeProbe(value);
  const text = decoded.value.toLowerCase(), tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = tokens.join("");
  let code: DeepPackagePurityIssueCode | undefined, message = "";
  if (/unity(?:player|editor|loader|framework|webgl|webassembly|web)/.test(compact)) {
    code = "forbidden-unity-runtime"; message = "Unity Player/Editor or Unity Web runtime artifact is forbidden.";
  } else if (/(?:^|[^a-z0-9])[^/\\]*\.data(?:$|[?#])/.test(text)) {
    code = "forbidden-unity-web-data"; message = "Unity-style Web data bundle is forbidden.";
  } else if (tokens.includes(FORBIDDEN_WEB_GL)) {
    code = "forbidden-webgl"; message = "WebGL runtime metadata is forbidden.";
  } else if (tokens.some(token => ["webview", "chromium", "electron", "cef"].includes(token))
    || compact.includes("webviewruntime")) {
    code = "forbidden-webview-runtime"; message = "WebView or Chromium runtime metadata is forbidden.";
  } else if (compact.includes("browserruntime") || compact.includes("browserbundle") || compact.includes("browsershell")) {
    code = "forbidden-browser-runtime"; message = "Packaged browser runtime metadata is forbidden.";
  } else if (tokens.some(token => token === "wasm" || token === "webassembly") || mimeContains(text, ["wasm", "webassembly"])
    || extension(text, ["wasm"])) {
    code = "forbidden-wasm-runtime"; message = "WASM runtime artifact is forbidden.";
  } else if (tokens.some(token => token === "javascript" || token === "ecmascript")
    || mimeContains(text, ["javascript", "ecmascript", "html", "css"])
    || extension(text, ["js", "mjs", "cjs", "jsx", "ts", "tsx", "html", "htm", "css"])) {
    code = "forbidden-script-runtime"; message = "JavaScript or browser runtime artifact is forbidden.";
  }
  if (code) {
    if (pathLike && decoded.obfuscated) add(state, "path-obfuscation", path,
      "Encoded or compatibility-normalized runtime path hides a forbidden artifact.");
    add(state, code, path, message);
  }
}

function auditAssetChunks(value: DeepAssetPackage, state: AuditState): void {
  let total = 0;
  for (const [index, blob] of value.blobs.entries()) {
    state.chunks++; total += blob.byteLength;
    if (blob.byteLength > DEEP_PACKAGE_PURITY_LIMITS.maxChunkBytes) add(state, "chunk-budget-exceeded",
      `$.blobs[${index}].byteLength`, "Asset chunk exceeds the fixed byte budget.");
    if (!Number.isSafeInteger(total) || total > DEEP_PACKAGE_PURITY_LIMITS.maxTotalChunkBytes) {
      add(state, "chunk-budget-exceeded", "$.blobs", "Aggregate asset chunks exceed the fixed byte budget."); break;
    }
  }
}

function auditChunkContainer(value: unknown, path: string, state: AuditState): void {
  const chunks = Array.isArray(value) ? value : [value];
  for (const [index, chunk] of chunks.entries()) {
    state.chunks++; const chunkPath = Array.isArray(value) ? `${path}[${index}]` : path;
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      add(state, "chunk-metadata-invalid", chunkPath, "Chunk metadata must be an object."); continue;
    }
    const descriptors = Object.getOwnPropertyDescriptors(chunk), byteLength = descriptors.byteLength?.value;
    if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0
      || byteLength > DEEP_PACKAGE_PURITY_LIMITS.maxChunkBytes)) {
      add(state, "chunk-metadata-invalid", `${chunkPath}.byteLength`, "Chunk byte length is outside the fixed budget.");
    }
  }
}

function createState(options: DeepPackagePurityOptions): AuditState {
  return { issues: [], seen: new WeakSet(), dedupe: new Set(), maxNodes: lowerLimit(options.maxNodes,
    DEEP_PACKAGE_PURITY_LIMITS.maxNodes, 8, "maxNodes"), maxIssues: lowerLimit(options.maxIssues,
    DEEP_PACKAGE_PURITY_LIMITS.maxIssues, 8, "maxIssues"), nodes: 0, strings: 0, chunks: 0, truncated: false };
}
function lowerLimit(value: number | undefined, ceiling: number, minimum: number, name: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < minimum || value > ceiling) throw new RangeError(`${name} exceeds package purity policy.`);
  return value;
}
function add(state: AuditState, code: DeepPackagePurityIssueCode, path: string, message: string): void {
  const key = `${code}\0${path}`; if (state.dedupe.has(key) || state.issues.length >= state.maxIssues) return;
  state.dedupe.add(key); state.issues.push(Object.freeze({ code, path, message }));
}
function finish(kind: DeepPackagePurityResult["packageKind"], state: AuditState): DeepPackagePurityResult {
  const issues = Object.freeze([...state.issues].sort((a, b) => a.path.localeCompare(b.path)
    || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)));
  return Object.freeze({ clean: issues.length === 0, packageKind: kind, issues,
    evidence: Object.freeze({ visitedNodes: state.nodes, inspectedStrings: state.strings,
      inspectedChunks: state.chunks, truncated: state.truncated }) });
}
function packageKind(value: unknown): DeepPackagePurityResult["packageKind"] {
  if (!value || typeof value !== "object") return "unknown";
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.schema?.value === DEEP_RUNTIME_PACKAGE_SCHEMA) return "runtime";
  return descriptors.manifest && descriptors.blobs ? "asset" : "unknown";
}
function metadataKey(key: string): boolean {
  return /(?:id|ids|name|path|uri|url|file|mime|mediatype|type|kind|format|runtime|loader|framework|platform|engine|dependency|dependencies|chunk|chunks|schema|profile|version|cachekey|language)$/i.test(key);
}
function skipPayload(key: string): boolean {
  return /^(?:data|dataBase64|vertices|indices|uv0|uv1|tangents|transform|inverseBindMatrices|source)$/i.test(key);
}
function chunkKey(key: string): boolean { return /^(?:chunk|chunks|chunkMetadata)$/i.test(key); }
function propertyPath(parent: string, key: string): string { return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`; }
function decodeProbe(value: string): { value: string; obfuscated: boolean } {
  const normalized = value.normalize("NFKC"); let decoded = normalized;
  try { for (let index = 0; index < 2 && /%[0-9a-f]{2}/i.test(decoded); index++) decoded = decodeURIComponent(decoded); }
  catch { return { value: normalized, obfuscated: true }; }
  return { value: decoded, obfuscated: decoded !== value };
}
function extension(value: string, values: readonly string[]): boolean {
  const suffix = value.split(/[?#]/, 1)[0]!.split(/[\\/]/).at(-1) ?? "";
  return values.some(item => suffix.endsWith(`.${item}`));
}
function mimeContains(value: string, values: readonly string[]): boolean {
  return /^(?:application|text)\//.test(value) && values.some(item => value.includes(item));
}
