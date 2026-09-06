import type { ModelRecord } from "@bim-studio/contracts";

/** 资源可重命名；格式和原始机器人入口仍应可检索。 */
export function projectModelMatchesSearch(model: ModelRecord, search: string): boolean {
  const query = search.normalize("NFKC").trim().toLocaleLowerCase();
  if (!query) return true;
  const robot = model.manifest?.robot;
  const text = [model.name, model.format, `.${model.format}`, model.manifest?.sourceName,
    robot?.name, robot?.entryPath, robot ? "urdf robot 机器人" : ""].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase();
  return query.split(/\s+/).every(term => text.includes(term));
}
