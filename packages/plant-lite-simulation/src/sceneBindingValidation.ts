import type { PlantLiteModelIssue } from "./modelTypes.js";

/** 可选编辑器绑定仅是证据元数据，但不能接受失真坐标或不属于本模型的节点。 */
export function validateSceneBinding(input: unknown, nodeIds: ReadonlySet<string>, issues: PlantLiteModelIssue[]): void {
  if (input === undefined) return;
  const fail = () => issues.push({ path: "$.sceneBinding", message: "场景绑定必须完整对应模型节点，且包含有效对象标识与有限三维坐标" });
  if (!input || typeof input !== "object") { fail(); return; }
  const binding = input as Record<string, unknown>;
  if (typeof binding.sceneId !== "string" || !binding.sceneId.trim() || !Array.isArray(binding.nodes) || binding.nodes.length !== nodeIds.size) { fail(); return; }
  const seen = new Set<string>();
  const objects = new Set<string>();
  for (const value of binding.nodes) {
    if (!value || typeof value !== "object") { fail(); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.nodeId !== "string" || !nodeIds.has(node.nodeId) || seen.has(node.nodeId)
      || typeof node.objectId !== "string" || !node.objectId.trim() || objects.has(node.objectId)
      || !Array.isArray(node.position) || node.position.length !== 3 || !node.position.every(value => typeof value === "number" && Number.isFinite(value))) { fail(); return; }
    seen.add(node.nodeId); objects.add(node.objectId);
  }
}
