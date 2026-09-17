import { JtFormatError, type JtMeshInstance } from "@bim-studio/jt-reader";
import type { JtMaterialEvidence } from "./jtInspection.js";

export interface JtResolvedMaterial {
  status: "source-path" | "missing" | "ambiguous";
  sourceObjectIds: number[];
  evidence?: JtMaterialEvidence;
  key: string;
}

/** 当前 reader 未暴露完整属性覆盖标志；多种源材质同时在路径上时保留歧义。 */
export function createJtMaterialResolver(materials: readonly JtMaterialEvidence[]) {
  const byId = new Map<number, JtMaterialEvidence>();
  for (const material of materials) {
    if (byId.has(material.objectId)) throw new JtFormatError("JT 材质源节点重复");
    byId.set(material.objectId, material);
  }
  return (instance: Pick<JtMeshInstance, "pathObjectIds">): JtResolvedMaterial => {
    const found = instance.pathObjectIds.flatMap((id) => {
      const material = byId.get(id);
      return material ? [material] : [];
    });
    const keys = new Set(found.map(materialKey));
    const sourceObjectIds = found.map((material) => material.objectId);
    if (keys.size !== 1) return { status: found.length ? "ambiguous" : "missing", sourceObjectIds, key: "unassigned" };
    return { status: "source-path", sourceObjectIds, evidence: found[0]!, key: materialKey(found[0]!) };
  };
}

function materialKey(material: JtMaterialEvidence): string {
  return JSON.stringify([material.diffuse, material.opacity, material.shininess, material.reflectivity]);
}
