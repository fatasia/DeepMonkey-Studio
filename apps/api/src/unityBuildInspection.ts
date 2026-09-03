import type { UnityWebBuildProfile } from "@bim-studio/contracts";

export interface UnityBuildFileEvidence {
  path: string;
  size: number;
}

/** 验证 ZIP 是完整 Unity Web 播放器，而不只是带 index.html 的任意压缩包。 */
export function inspectUnityWebBuild(files: readonly UnityBuildFileEvidence[]): UnityWebBuildProfile {
  const loader = files.find((file) => runtimeRole(file.path) === "loader");
  const framework = files.find((file) => runtimeRole(file.path) === "framework");
  const wasm = files.find((file) => runtimeRole(file.path) === "wasm");
  const data = files.find((file) => runtimeRole(file.path) === "data");
  const missing = [
    [loader, "Loader"],
    [framework, "Framework"],
    [wasm, "WASM"],
    [data, "Data"],
  ].flatMap(([file, label]) => file ? [] : [label as string]);
  if (missing.length > 0) throw new Error(`Unity WebGL 构建不完整，缺少：${missing.join("、")}`);

  const runtimeFiles = [loader!, framework!, wasm!, data!];
  const encodings = new Set([framework!, wasm!, data!].map((file) => fileEncoding(file.path)));
  const compression = encodings.size === 1 ? [...encodings][0]! : "mixed";
  return {
    compression,
    runtimePayloadBytes: runtimeFiles.reduce((sum, file) => sum + file.size, 0),
    wasmBytes: wasm!.size,
    dataBytes: data!.size,
    runtimeFileCount: runtimeFiles.length,
    debugSymbols: files.some((file) => stripEncoding(file.path).toLowerCase().endsWith(".symbols.json")),
  };
}

export function unityBuildDiagnostics(profile: UnityWebBuildProfile): string[] {
  const diagnostics: string[] = [];
  if (profile.compression === "uncompressed") diagnostics.push("Unity 运行载荷未压缩，首次启动下载量会明显增加");
  if (profile.compression === "decompression-fallback") diagnostics.push("Unity 使用浏览器端解压回退，会增加启动期 CPU 与内存开销");
  if (profile.compression === "mixed") diagnostics.push("Unity 运行文件压缩方式不一致，请重新检查 Web 发布设置");
  if (profile.debugSymbols) diagnostics.push("构建包含调试符号，正式交付前建议改用非 Development Build");
  return diagnostics;
}

function runtimeRole(value: string): "loader" | "framework" | "wasm" | "data" | undefined {
  const name = stripEncoding(value).toLowerCase();
  if (name.endsWith(".loader.js")) return "loader";
  if (name.endsWith(".framework.js")) return "framework";
  if (name.endsWith(".wasm")) return "wasm";
  if (name.endsWith(".data")) return "data";
  return undefined;
}

function fileEncoding(value: string): UnityWebBuildProfile["compression"] {
  const lower = value.toLowerCase();
  if (lower.endsWith(".br")) return "brotli";
  if (lower.endsWith(".gz")) return "gzip";
  if (lower.endsWith(".unityweb")) return "decompression-fallback";
  return "uncompressed";
}

function stripEncoding(value: string): string {
  return value.replace(/\.(?:br|gz|unityweb)$/i, "");
}
