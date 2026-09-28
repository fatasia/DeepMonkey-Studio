import type { PlantLiteModel, PlantLiteNode, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { instantiateClass, validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";

function rejectExisting(node: PlantLiteNode | undefined): asserts node is Extract<PlantLiteNode, { kind: "station" }> {
  if (!node || node.kind !== "station") throw new Error("请选择已有加工工位，当前仅支持单工位类模板。");
}

/** Class definitions and materialized nodes live in the same saved Plant Study model. */
export function createStationClass(request: PlantLiteStudyRequest, stationId: string, classId: string): PlantLiteStudyRequest {
  const model = request.model;
  if (!model) throw new Error("请先建立产线模型。");
  const source = model.nodes.find((node) => node.id === stationId);
  rejectExisting(source);
  const id = classId.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id)) throw new Error("类 ID 需以字母开头，仅支持字母、数字、-、_，最长 40 字符。");
  if (model.classLibrary?.some((entry) => entry.classId === id)) throw new Error(`类 ${id} 已存在。`);
  if (source.resourceId || source.workerResourceId) throw new Error("共享设备或人工引用无法自动克隆，请选未绑定资源的工位。");
  const { inheritedFromClassId: _inherited, propertyOverrides: _overrides, ...template } = source;
  const next = { ...model, classLibrary: [...(model.classLibrary ?? []), { classId: id, name: `${source.name} 类`, nodes: [{ ...template, id: "station" }] }] };
  const validation = validatePlantLiteModel(next);
  if (!validation.valid) throw new Error("类模板无效，请检查工位属性与模型配置。");
  return { ...request, model: next };
}

/** The linear Operations authoring path inserts one materialized station before the sink. */
export function insertStationClassInstance(request: PlantLiteStudyRequest, classId: string): PlantLiteStudyRequest {
  const model = request.model;
  if (!model) throw new Error("请先建立产线模型。");
  const classDefinition = model.classLibrary?.find((item) => item.classId === classId);
  if (!classDefinition || classDefinition.nodes.length !== 1 || classDefinition.nodes[0]?.kind !== "station" || classDefinition.resources?.length) {
    throw new Error("仅支持已保存的单工位且无内置资源的类；其他类请在高级模型编辑器处理。");
  }
  const sink = model.nodes.at(-1);
  if (!sink || sink.kind !== "sink" || model.edges.length !== model.nodes.length - 1 || model.nodes.length < 2) {
    throw new Error("当前不是单条串行流程，类实例不会自动连线；请先修复顺序连接。");
  }
  const prior = model.nodes.at(-2)!;
  if (!model.edges.some((edge) => edge.from === prior.id && edge.to === sink.id)) {
    throw new Error("末端连接与节点顺序不一致，请先修复模型。");
  }
  const materialized = instantiateClass(model, classId);
  const instance = materialized.nodes.at(-1)!;
  const edgeId = (suffix: string) => {
    let candidate = `${instance.id}-${suffix}`;
    for (let index = 1; model.edges.some((edge) => edge.id === candidate); index += 1) candidate = `${instance.id}-${suffix}-${index}`;
    return candidate;
  };
  const next: PlantLiteModel = {
    ...materialized,
    nodes: [...model.nodes.slice(0, -1), instance, sink],
    edges: [...model.edges.filter((edge) => !(edge.from === prior.id && edge.to === sink.id)),
      { id: edgeId("in"), from: prior.id, to: instance.id }, { id: edgeId("out"), from: instance.id, to: sink.id }],
  };
  if (!validatePlantLiteModel(next).valid) throw new Error("类实例连接后模型校验失败，草稿未更改。");
  return { ...request, model: next };
}
