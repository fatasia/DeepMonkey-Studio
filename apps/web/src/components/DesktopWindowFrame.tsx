import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { isTauriRuntime } from "../adapters/tauriHostAdapter.js";
import "./DesktopWindowFrame.css";

type WindowAction = "minimize" | "maximize" | "close";

function runWindowAction(action: WindowAction): void {
  const appWindow = getCurrentWindow();
  const operation = action === "minimize"
    ? appWindow.minimize()
    : action === "maximize"
      ? appWindow.toggleMaximize()
      : appWindow.close();
  void operation.catch((error) => console.error(`DESKTOP_WINDOW_${action.toUpperCase()}_FAILED`, error));
}

export function DesktopWindowFrame({ children }: { children: ReactNode }) {
  if (typeof window === "undefined" || !isTauriRuntime(window)) return children;

  return <div className="desktop-window-frame">
    <header className="desktop-window-titlebar" aria-label="桌面窗口标题栏">
      <div
        className="desktop-window-drag-region"
        data-tauri-drag-region
        onDoubleClick={() => runWindowAction("maximize")}
      >
        <span className="desktop-window-mark" aria-hidden="true" />
        <strong data-tauri-drag-region>DeepMonkey Studio</strong>
        <span data-tauri-drag-region>桌面工作台</span>
      </div>
      <div className="desktop-window-controls" role="group" aria-label="窗口控制">
        <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => runWindowAction("minimize")}>
          <Minus size={15} strokeWidth={1.7} />
        </button>
        <button type="button" aria-label="最大化或还原窗口" title="最大化或还原" onClick={() => runWindowAction("maximize")}>
          <Square size={11} strokeWidth={1.7} />
        </button>
        <button className="desktop-window-close" type="button" aria-label="关闭窗口" title="关闭" onClick={() => runWindowAction("close")}>
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </header>
    <div className="desktop-window-content">{children}</div>
  </div>;
}
