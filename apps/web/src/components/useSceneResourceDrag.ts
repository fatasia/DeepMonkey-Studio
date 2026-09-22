import { useEffect, useRef, type DragEvent } from "react";
import { readSceneAssetDrag, SCENE_ASSET_MIME, type SceneAssetDrag } from "./sceneAssetDrag";

const sessionMime = "application/x-bim-studio-asset-session";

/** 只有当前资源面板发起、且落在显式接收区域的拖放才能提交。 */
export function useSceneResourceDrag(owner: string | undefined, insert: (asset: SceneAssetDrag) => void | Promise<void>) {
  const session = useRef<{ token: string; asset: SceneAssetDrag } | undefined>(undefined);
  const cancel = () => { session.current = undefined; };
  useEffect(() => {
    cancel();
    const escape = (event: KeyboardEvent) => {
      if (!session.current || event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("dragend", cancel, true);
    return () => { cancel(); window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", cancel); window.removeEventListener("dragend", cancel, true); };
  }, [owner]);
  return {
    begin(event: DragEvent, source: SceneAssetDrag["source"], id: string) {
      const asset = { source, id }, token = crypto.randomUUID();
      session.current = { token, asset };
      event.stopPropagation(); event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(SCENE_ASSET_MIME, JSON.stringify(asset));
      event.dataTransfer.setData(sessionMime, token);
    },
    over(event: DragEvent) {
      if (!session.current || !event.dataTransfer.types.includes(sessionMime)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy";
    },
    async drop(event: DragEvent) {
      const active = session.current;
      if (!active || event.dataTransfer.getData(sessionMime) !== active.token) return;
      const payload = readSceneAssetDrag(event.dataTransfer.getData(SCENE_ASSET_MIME));
      if (!payload || payload.source !== active.asset.source || payload.id !== active.asset.id) { cancel(); return; }
      event.preventDefault(); event.stopPropagation(); cancel();
      await insert(payload);
    },
    cancel,
  };
}
