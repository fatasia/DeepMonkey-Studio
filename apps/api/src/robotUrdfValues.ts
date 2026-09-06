import path from "node:path";
import type { RobotMaterialDefinition, RobotOrigin, Vector3Value } from "@bim-studio/contracts";

export type XmlNode = Record<string, unknown>;
export function node(value: unknown, label: string): XmlNode {
  if (value === "") return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 结构无效`);
  return value as XmlNode;
}
export const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
export function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\u0000-\u001f"'\\\[\]]/.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)) throw new Error(`${label} 名称无效`);
  return value;
}
export function number(value: unknown, label: string, minimum = -Infinity): number {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw new Error(`${label} 不是有效数字`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) throw new Error(`${label} 数值超出范围`);
  return result;
}
export function vector(value: unknown, fallback: Vector3Value, label: string, minimum = -Infinity): Vector3Value {
  if (value === undefined) return { ...fallback };
  if (typeof value !== "string") throw new Error(`${label} 必须是三个数值`);
  const components = value.trim().split(/\s+/);
  if (components.length !== 3) throw new Error(`${label} 必须是三个数值`);
  return { x: number(components[0], label, minimum), y: number(components[1], label, minimum), z: number(components[2], label, minimum) };
}
export function origin(value: unknown): RobotOrigin {
  const source = value === undefined ? {} : node(value, "origin");
  return { xyz: vector(source["@_xyz"], { x: 0, y: 0, z: 0 }, "origin.xyz"), rpy: vector(source["@_rpy"], { x: 0, y: 0, z: 0 }, "origin.rpy") };
}

/** 原始压缩条目不可含路径折返；URDF 相对引用另在包内解析。 */
export function robotArchivePath(value: string): string {
  if (!value || value.length > 512 || /[\\:\u0000-\u001f?#]/.test(value) || value.startsWith("/") ||
    value.split("/").some(part => part === ".." || part === "." || ["__proto__", "prototype", "constructor"].includes(part))) throw new Error(`机器人包路径无效：${value.slice(0, 100)}`);
  const normalized = value.normalize("NFKC");
  if (normalized !== value || path.posix.normalize(value) !== value.replace(/\/$/, "")) throw new Error(`机器人包路径不规范：${value.slice(0, 100)}`);
  // 避免包内字面 % 编码被 URL/加载器再次解码成路径折返或分隔符。
  if (/%/.test(value)) throw new Error("机器人包条目名称不可包含百分号编码");
  return value;
}

export function robotResourcePath(filename: unknown, entryPath: string, availableFiles: ReadonlySet<string>): { filename: string; resolvedPath: string } {
  if (typeof filename !== "string" || filename.length > 512) throw new Error("机器人网格/纹理路径无效");
  let decoded: string;
  try { decoded = decodeURIComponent(filename); } catch { throw new Error("机器人资源路径编码无效"); }
  if (/[\\\u0000-\u001f?#]/.test(decoded)) throw new Error("机器人资源路径无效");
  let candidates: string[];
  if (decoded.startsWith("package://")) {
    const packagePath = robotArchivePath(decoded.slice(10));
    candidates = [...availableFiles].filter(file => file === packagePath || file.endsWith(`/${packagePath}`));
  } else {
    if (decoded.startsWith("/") || decoded.includes(":")) throw new Error("机器人资源只允许包内相对路径");
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), decoded));
    robotArchivePath(target);
    candidates = availableFiles.has(target) ? [target] : [];
  }
  if (candidates.length !== 1) throw new Error(`${candidates.length ? "资源映射不唯一" : "缺少机器人资源"}：${filename}`);
  return { filename, resolvedPath: candidates[0]! };
}

export function material(value: unknown, entryPath: string, files: ReadonlySet<string>): RobotMaterialDefinition {
  const source = node(value, "material");
  const result: RobotMaterialDefinition = {};
  if (source["@_name"] !== undefined) result.name = name(source["@_name"], "material");
  if (source.color !== undefined) {
    const color = node(source.color, "material.color")["@_rgba"];
    if (typeof color !== "string" || color.trim().split(/\s+/).length !== 4) throw new Error("material.color 必须是四个分量");
    const rgba = color.trim().split(/\s+/).map(value => number(value, "material.color", 0));
    if (rgba.some(value => value > 1)) throw new Error("material.color 分量超过 1");
    result.color = rgba as [number, number, number, number];
  }
  if (source.texture !== undefined) result.texture = robotResourcePath(node(source.texture, "texture")["@_filename"], entryPath, files);
  return result;
}
