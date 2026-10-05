export const SCENE_ASSET_MIME = "application/x-bim-studio-asset";
/** source = 资源面板三范围的可拖实体;userPrefab 是项目内用户组合预制体(实例化走 prefabId)。 */
export interface SceneAssetDrag { source: "library" | "model" | "userPrefab"; id: string }

/** 拖拽只传标识；接收方重新从当前项目/目录解析，拒绝外来模型配置。 */
export function readSceneAssetDrag(raw: string): SceneAssetDrag | undefined {
  if (raw.length > 2048) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2
      || (record.source !== "library" && record.source !== "model" && record.source !== "userPrefab")) return;
    if (typeof record.id !== "string" || !record.id.trim() || record.id.length > 512) return;
    return { source: record.source, id: record.id };
  } catch { return; }
}
