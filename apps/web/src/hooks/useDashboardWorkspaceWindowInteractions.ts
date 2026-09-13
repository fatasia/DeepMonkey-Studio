import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DashboardContextMenuState } from "../components/dashboardWorkspaceModel";

interface DashboardWorkspaceWindowInteractionsOptions {
  contextMenu: DashboardContextMenuState | undefined;
  setContextMenu: Dispatch<SetStateAction<DashboardContextMenuState | undefined>>;
  spacePressedRef: RefObject<boolean>;
}

/** 管理工作区依赖的窗口级关闭与空格平移手势，确保监听随组件生命周期释放。 */
export function useDashboardWorkspaceWindowInteractions({
  contextMenu,
  setContextMenu,
  spacePressedRef,
}: DashboardWorkspaceWindowInteractionsOptions) {
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu, setContextMenu]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code === "Space" && !target?.matches("input,textarea,select,[contenteditable=true]")) {
        spacePressedRef.current = true;
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressedRef.current = false;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [spacePressedRef]);
}
