import { createHash } from "node:crypto";
import type { PublishedSceneRecord } from "@bim-studio/contracts";

/** 身份包含完整发布内容；键顺序和 JSON 省略的 undefined 不改变身份。 */
export function cloudRenderPublicationIdentity(publication: PublishedSceneRecord): string {
  const value: unknown = JSON.parse(JSON.stringify({ projectId: publication.projectId, sceneId: publication.sceneId,
    version: publication.version, publishedAt: publication.publishedAt, snapshot: publication.snapshot }, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("云渲染发布内容包含非有限数值");
    if (["function", "symbol", "bigint"].includes(typeof item)) throw new Error("云渲染发布内容不是 JSON");
    return item;
  }));
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
