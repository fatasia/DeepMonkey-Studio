import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { verifySceneClientArchive, sceneClientArchiveLimits } from "../../../scripts/lib/sceneClientArchive.mjs";

const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const JSZip = requireWeb("jszip");

/** 从已冻结的交付包读取资源，不再请求最新草稿或线上可变资源。 */
export async function readSceneViewerArchiveSource(file) {
  if ((await stat(file)).size > sceneClientArchiveLimits.archiveBytes) throw new Error("客户端 ZIP 超过读取限额");
  const bytes = await readFile(file);
  const { manifest } = await verifySceneClientArchive(bytes, { expectedTarget: "three-webview" });
  if (manifest.purpose !== "delivery" || !manifest.publishedAt) throw new Error("客户端构建需要正式发布包");
  const zip = await JSZip.loadAsync(bytes);
  const readJson = async name => JSON.parse(await zip.file(name).async("string"));
  const [scene, project, applications, runtime] = await Promise.all(
    ["scene.json", "project.json", "applications.json", "runtime.json"].map(readJson));
  if (scene.id !== manifest.sceneId || scene.projectId !== manifest.projectId || project.id !== manifest.projectId
    || scene.publishedAt !== manifest.publishedAt) throw new Error("发布包场景身份不一致");
  const resources = new Map();
  for (const entry of manifest.files.filter(item => item.path.startsWith("assets/"))) {
    resources.set(`/archive/${entry.path}`, await zip.file(entry.path).async("nodebuffer"));
  }
  const rewrite = value => {
    if (typeof value === "string") return resources.has(`/archive/${value}`) ? `/archive/${value}` : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
  };
  return {
    publication: { sceneId: scene.id, projectId: scene.projectId, name: scene.name,
      publishedAt: manifest.publishedAt, snapshot: rewrite(scene) },
    project: rewrite(project), applications: rewrite(applications), runtime: rewrite(runtime),
    resources, manifest,
  };
}
