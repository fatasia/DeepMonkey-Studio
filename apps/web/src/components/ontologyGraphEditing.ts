import { parseOntologyGraphNodeId, validateOntologyPackageShape, type OntologyPackage, type OntologyRelationType } from "@bim-studio/contracts";
import { newRelationDraft } from "./ontologyWorkspaceLogic";

export function graphRelationDraft(pkg: OntologyPackage, sourceId: string, targetId: string, relationKey?: string): OntologyRelationType {
  const source = parseOntologyGraphNodeId(sourceId), target = parseOntologyGraphNodeId(targetId);
  if (source?.kind !== "object" || target?.kind !== "object") throw new Error("业务关系只能连接对象；来源、事件与行动绑定在对应资产中配置");
  if (!pkg.objects.some(object => object.key === source.key) || !pkg.objects.some(object => object.key === target.key)) throw new Error("关系两端对象不存在");
  const original = relationKey ? pkg.relations.find(relation => relation.key === relationKey) : undefined;
  if (relationKey && !original) throw new Error("原关系已不存在，请重新查询图谱");
  const relation = structuredClone(original ?? newRelationDraft(pkg));
  relation.sourceObject = source.key; relation.targetObject = target.key;
  // A changed endpoint must not retain a field absent from its new object.
  if (!pkg.objects.find(object => object.key === source.key)?.properties.some(property => property.key === relation.keyMapping.sourceField)) relation.keyMapping.sourceField = "";
  if (!pkg.objects.find(object => object.key === target.key)?.properties.some(property => property.key === relation.keyMapping.targetField)) relation.keyMapping.targetField = "";
  return relation;
}

export function applyGraphRelation(pkg: OntologyPackage, relation: OntologyRelationType): OntologyPackage {
  if (pkg.relations.some(item => item.key === relation.key && item.id !== relation.id)) throw new Error("关系标识已存在，请使用不同标识");
  const next = { ...pkg, relations: pkg.relations.some(item => item.id === relation.id)
    ? pkg.relations.map(item => item.id === relation.id ? structuredClone(relation) : item)
    : [...pkg.relations, structuredClone(relation)] };
  const errors = validateOntologyPackageShape(next);
  if (errors.length) throw new Error(errors.join("；"));
  return next;
}
