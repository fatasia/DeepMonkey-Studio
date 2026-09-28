import type { Object3D } from "three";
import type { ModelManifest } from "@bim-studio/contracts";

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
  const broken: string[] = [];
  for (const [id, before] of nodes(previous)) {
    const after = next.get(id);
    if (!after || after.name !== before.name || after.type !== before.type) {
      const reason = !after ? "已删除" : after.name !== before.name ? "已重命名" : "类型已变";
      broken.push(`${id.slice(0, 120)} ${reason}`);
    }
  }
  if (broken.length) throw new Error(`新素材的子构件结构不兼容，${broken.length} 处原引用断链：${broken.slice(0, 5).join("；")}${broken.length > 5 ? "；…" : ""}。原实例未修改，请选择兼容素材或新增实例`);
}

/**
 * Deep Asset Package 引用进入替换事务前的结构门禁：
 * 引用不完整的素材先被拒绝并明确报错，避免下游 CAS/再导入消费到脏引用。
 */
export function assertDeepAssetPackageReference(manifest: ModelManifest): void {
  const reference = manifest.deepAssetPackage;
  if (!reference) return;
  const problems: string[] = [];
  if (typeof reference.packageId !== "string" || !reference.packageId) problems.push("packageId");
  if (typeof reference.revision !== "number" || !Number.isSafeInteger(reference.revision) || reference.revision < 0) problems.push("revision");
  if (typeof reference.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(reference.sourceHash)) problems.push("sourceHash");
  if (typeof reference.entryScene !== "string" || !reference.entryScene) problems.push("entryScene");
  if (typeof reference.packageUrl !== "string" || !reference.packageUrl) problems.push("packageUrl");
  if (problems.length) {
    throw new Error(`素材“${manifest.sourceName}”的资产包引用不完整（缺少或非法字段：${problems.join("、")}），已保留原实例，请对该素材重新转换`);
  }
}
