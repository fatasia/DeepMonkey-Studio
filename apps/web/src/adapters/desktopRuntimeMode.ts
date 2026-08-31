export type DesktopRuntimeMode = "local" | "server";

const STORAGE_KEY = "bim-studio.desktop-runtime-mode";
const LOCAL_API_ORIGIN = "https://local.industrial-studio.invalid";

export function readDesktopRuntimeMode(browserWindow: Window = window): DesktopRuntimeMode | undefined {
  let value: string | null = null;
  try {
    value = browserWindow.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    // 禁用 WebView 存储或单元测试窗口不应阻断服务器配置读取。
  }
  return value === "local" || value === "server" ? value : undefined;
}

export function storeDesktopRuntimeMode(mode: DesktopRuntimeMode, browserWindow: Window = window): void {
  try {
    browserWindow.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // 仍派发进程内事件，使受限存储环境中的当前会话可以完成切换。
  }
  browserWindow.dispatchEvent(new CustomEvent("bim-studio-desktop-mode-changed", { detail: mode }));
}

export function isLocalDesktopMode(browserWindow: Window = window): boolean {
  return readDesktopRuntimeMode(browserWindow) === "local";
}

/** 本地工作台仍复用 ServerClient 的路径与错误合同，但请求由本地存储适配器接管。 */
export function localDesktopApiOrigin(): string {
  return LOCAL_API_ORIGIN;
}
