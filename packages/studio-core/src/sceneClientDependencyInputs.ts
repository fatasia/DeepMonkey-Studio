import { applicationToSceneSnapshotV1, type ApplicationDocument, type ProjectRecord,
  type SceneSnapshot, type SceneClientDependencyInputs } from "@bim-studio/contracts";
import { selectSceneClientApplications } from "./sceneClientApplications.js";
import { selectSceneClientResources } from "./sceneClientResources.js";
import { selectSceneClientRuntimeDependencies } from "./sceneClientRuntimeDependencies.js";
import { sanitizeTransferContent, sanitizeTransferUrl } from "./transferSanitization.js";

/** Web 预检与服务端冻结使用同一依赖闭包；网络读取在调用方执行。 */
export function selectSceneClientDependencyInputs(project: ProjectRecord, scene: SceneSnapshot,
  projectApplications: readonly ApplicationDocument[], options: { diagnostic?: boolean } = {}): SceneClientDependencyInputs {
  if (scene.projectId !== project.id) throw new Error("项目与待打包场景不一致");
  const selection = selectSceneClientApplications(scene, projectApplications);
  if (selection.unresolved.length) throw new Error(selection.unresolved.map(item => `${item.applicationId} · ${item.path}：${item.reason}`).join("\n"));
  const applications = selection.applications;
  const scenes = [scene, ...applications.flatMap(app => app.scenes.filter(value => value.id !== scene.id)
    .map(value => applicationToSceneSnapshotV1(app, value.id)))];
  const { models, assets, resources } = selectSceneClientResources(project, scenes, applications);
  for (const resource of resources) {
    if (!options.diagnostic && sanitizeTransferUrl(resource.url) !== resource.url) {
      throw new Error(`客户端资源 ${resource.id}：URL 含凭据、签名或非规范地址，无法稳定冻结，请使用项目内静态资源。`);
    }
  }
  for (const app of applications) {
    const owned = selectSceneClientResources(project, app.scenes.map(value => value.id === scene.id
      ? scene : applicationToSceneSnapshotV1(app, value.id)), [app]);
    const ids = new Set([...owned.models.map(model => `model:${model.id}`), ...owned.assets.map(asset => `${asset.kind}:${asset.id}`)]);
    app.assets = app.assets.filter(asset => ids.has(`${asset.kind}:${asset.id}`));
  }
  const runtime = selectSceneClientRuntimeDependencies(project, scenes, applications);
  const selected = { project: { id: project.id, name: project.name, description: project.description, models, assets }, applications, runtime };
  // 诊断导出在字节读取及 URL 替换后脱敏，签名只用于本次读取，不形成可重试的发布记录。
  return { ...(options.diagnostic ? selected : sanitizeTransferContent(selected)), resources };
}
