import type { ApplicationDocument, DataConnectionRecord, DataDatasetRecord, DataPipelineDefinition,
  ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";

type Binding = { datasetId?: string; pipelineId?: string; semanticBinding?: unknown };
const fail = (path: string, reason: string): never => { throw new Error(`客户端数据依赖 ${path}：${reason}`); };

/** 只选择合同声明的数据依赖；结果保持项目顺序，并与作者可变对象隔离。 */
export function selectSceneClientRuntimeDependencies(project: ProjectRecord, scenes: readonly SceneSnapshot[],
  applications: readonly ApplicationDocument[]): { connections: DataConnectionRecord[]; datasets: DataDatasetRecord[];
    pipelines: DataPipelineDefinition[] } {
  const connections = new Set<string>(), datasets = new Set<string>(), pipelines = new Set<string>();
  const resolve = <T extends { id: string; projectId: string }>(items: readonly T[], id: string, path: string): T => {
    const matches = items.filter(item => item.id === id);
    if (matches.length !== 1) fail(path, `${id} ${matches.length ? "标识重复" : "不存在"}`);
    const item = matches[0]!;
    if (item.projectId !== project.id) fail(path, `${id} 属于其他项目`);
    return item;
  };
  const connection = (id: string, path: string) => {
    if (!id?.trim()) fail(path, "连接 ID 为空");
    resolve(project.dataConnections ?? [], id, path); connections.add(id);
  };
  const dataset = (id: string, path: string) => {
    const value = resolve(project.datasets ?? [], id, path);
    if (datasets.has(id)) return;
    datasets.add(id); connection(value.connectionId, `${path}(${id}).connectionId`);
  };
  const pipeline = (id: string, path: string) => {
    const value = resolve(project.dataPipelines ?? [], id, path);
    if (pipelines.has(id)) return;
    pipelines.add(id); validatePipelineEdges(value, `${path}(${id})`);
    value.nodes.forEach((node, index) => {
      if (node.type === "source") dataset(node.datasetId, `${path}(${id}).nodes[${index}].datasetId`);
    });
  };
  const binding = (value: Binding, path: string) => {
    if (value.semanticBinding) fail(`${path}.semanticBinding`, "unsupported：语义模型尚无客户端依赖交付协议");
    if (value.datasetId) dataset(value.datasetId, `${path}.datasetId`);
    if (value.pipelineId) pipeline(value.pipelineId, `${path}.pipelineId`);
  };
  const sceneBindings = (value: Pick<SceneSnapshot, "dataBindings">, path: string) => {
    value.dataBindings?.forEach((item, index) => binding(item, `${path}.dataBindings[${index}]`));
  };
  scenes.forEach((scene, index) => {
    const path = `scenes[${index}]`;
    if (scene.projectId !== project.id) fail(`${path}.projectId`, "场景属于其他项目");
    sceneBindings(scene, path);
    scene.dashboard?.widgets.forEach((widget, i) => binding(widget, `${path}.dashboard.widgets[${i}]`));
    scene.interactions?.forEach((script, i) => {
      if (script.enabled && script.code.trim()) fail(`${path}.interactions[${i}].code`, "unsupported：任意脚本的数据依赖无法静态枚举");
    });
  });
  applications.forEach((application, index) => {
    const path = `applications[${index}]`;
    if (application.metadata.projectId !== project.id) fail(`${path}.metadata.projectId`, "应用属于其他项目");
    application.data.connectionIds.forEach((id, i) => connection(id, `${path}.data.connectionIds[${i}]`));
    application.data.datasetIds.forEach((id, i) => dataset(id, `${path}.data.datasetIds[${i}]`));
    application.scenes.forEach((scene, i) => sceneBindings(scene, `${path}.scenes[${i}]`));
    application.pages.forEach((page, i) => page.nodes.forEach((node, j) => {
      if (node.kind === "data-widget") binding(node.widget, `${path}.pages[${i}].nodes[${j}].widget`);
    }));
    application.interactions.forEach((flow, i) => {
      if (flow.enabled && flow.legacyScript?.script.code.trim()) fail(`${path}.interactions[${i}].legacyScript`, "unsupported：任意脚本的数据依赖无法静态枚举");
    });
    application.scripts.forEach((script, i) => {
      if (script.enabled && script.code.trim() && (script.runtime === "legacy-trusted-main-thread"
        || script.permissions.some(permission => ["data.read", "data.write", "network.connect"].includes(permission)))) {
        fail(`${path}.scripts[${i}]`, "unsupported：动态脚本的数据依赖无法静态枚举");
      }
    });
  });
  return structuredClone({ connections: (project.dataConnections ?? []).filter(item => connections.has(item.id)),
    datasets: (project.datasets ?? []).filter(item => datasets.has(item.id)),
    pipelines: (project.dataPipelines ?? []).filter(item => pipelines.has(item.id)) });
}

function validatePipelineEdges(pipeline: DataPipelineDefinition, path: string): void {
  const outgoing = new Map(pipeline.nodes.map(node => [node.id, [] as string[]]));
  if (outgoing.size !== pipeline.nodes.length) fail(`${path}.nodes`, "节点 ID 重复");
  pipeline.edges.forEach((edge, index) => {
    if (!outgoing.has(edge.sourceNodeId) || !outgoing.has(edge.targetNodeId)) fail(`${path}.edges[${index}]`, "引用不存在的节点");
    outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId);
  });
  // Kahn 拓扑检查避免深层管线递归溢出，也拒绝闭环而不是静默跳过。
  const incoming = new Map(pipeline.nodes.map(node => [node.id, 0]));
  for (const targets of outgoing.values()) for (const id of targets) incoming.set(id, incoming.get(id)! + 1);
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) for (const target of outgoing.get(queue[index]!)!) {
    incoming.set(target, incoming.get(target)! - 1);
    if (incoming.get(target) === 0) queue.push(target);
  }
  if (queue.length !== pipeline.nodes.length) fail(`${path}.edges`, "管线存在循环");
}
