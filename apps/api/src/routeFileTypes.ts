import path from "node:path";
import { supportedExtensions, type ModelFormat } from "@bim-studio/contracts";

export function cleanFileName(fileName: string): string {
  // Normalize both separators before basename: uploads can originate on a
  // Windows client while the API runs on Linux in CI/production.
  const normalized = path.posix.basename(fileName.replaceAll("\\", "/")).normalize("NFKC");
  return normalized.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180) || "model";
}

export function modelFormat(fileName: string): ModelFormat | undefined {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  return supportedExtensions.find((item) => item === extension);
}

export function contentType(fileName: string): string {
  const extension = path.extname(uncompressedAssetName(fileName)).toLowerCase();
  const imageType = imageContentType(extension);
  if (imageType) return imageType;
  const videoType = videoContentType(extension);
  if (videoType) return videoType;
  if (extension === ".json" || extension === ".gltf") return "application/json; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".data" || extension === ".mem" || extension === ".symbols.json") return "application/octet-stream";
  if (extension === ".glb") return "model/gltf-binary";
  if (extension === ".obj") return "model/obj";
  if (extension === ".stl") return "model/stl";
  if (extension === ".3mf") return "model/3mf";
  if (extension === ".dae") return "model/vnd.collada+xml";
  if (extension === ".3ds") return "application/x-3ds";
  if (extension === ".ifc") return "application/x-step";
  if (extension === ".dxf") return "application/dxf";
  if (extension === ".dwg") return "application/acad";
  if (extension === ".step" || extension === ".stp") return "model/step";
  if (extension === ".iges" || extension === ".igs") return "model/iges";
  if (extension === ".usd" || extension === ".usda") return "model/usd";
  if (extension === ".usdc") return "application/octet-stream";
  if (extension === ".usdz") return "model/vnd.usdz+zip";
  return "application/octet-stream";
}

/** Unity Web 构建会直接请求 *.wasm.br / *.data.gz；响应必须声明原始编码。 */
export function assetContentEncoding(fileName: string): "br" | "gzip" | undefined {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".br") return "br";
  if (extension === ".gz") return "gzip";
  return undefined;
}

function uncompressedAssetName(fileName: string): string {
  return assetContentEncoding(fileName) ? fileName.slice(0, -path.extname(fileName).length) : fileName;
}

export function imageContentType(extension: string): string | undefined {
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" } as Record<string, string>)[extension];
}

export function videoContentType(extension: string): string | undefined {
  return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime" } as Record<string, string>)[extension];
}
