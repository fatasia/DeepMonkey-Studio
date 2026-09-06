import type { Object3D } from "three";

/** 不把旧子构件引用猜测性地指向新几何；结构不兼容时保留原实例并让用户新增。 */
export function assertModelReplacementCompatible(previous: Object3D, candidate: Object3D): void {
  const nodes = (root: Object3D) => {
    const result = new Map<string, { name: string; type: string }>();
    const visit = (node: Object3D, path: string) => {
      const element = node.userData.NodeType === "Element" ? node.userData.ElementId : undefined;
      const preferred = typeof element === "string" || typeof element === "number" ? `element:${element}` : path;
      const id = result.has(preferred) ? path : preferred;
      result.set(id, { name: path === "root" ? "" : node.name, type: node.type });
      node.children.forEach((child, index) => visit(child, `${path}/${index}`));
    };
    visit(root, "root");
    return result;
  };
  const next = nodes(candidate);
  for (const [id, before] of nodes(previous)) {
    const after = next.get(id);
    if (!after || after.name !== before.name || after.type !== before.type) {
      throw new Error("新素材的子构件结构不兼容，无法保持原引用；原实例未修改，请选择兼容素材或新增实例");
    }
  }
}
