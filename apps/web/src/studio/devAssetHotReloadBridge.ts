/**
 * 开发服务器资产热重载的浏览器端桥:订阅 vite 原生 HMR 通道的资产变更事件。
 *
 * 仅在 vite dev(import.meta.hot 可用)下生效;生产构建 import.meta.hot 为
 * undefined,连接函数如实返回 noop——运行中热重载由浮窗"重新加载"按钮兜底。
 * 事件聚合(多文件一次保存)已在 vite 插件侧完成,这里只做去抖转发。
 */
import type { AssetChangedDetail } from "../../vite/assetHotReloadPlugin";

/** 与 vite/assetHotReloadPlugin.ts 的 ASSET_CHANGED_EVENT 逐字一致;相等性由契约测试钉住(此处不能 import 插件,避免 node 依赖进客户端包)。 */
export const ASSET_CHANGED_EVENT = "bim-studio:asset-changed";

interface ViteHotContextLike {
  on(event: string, handler: (payload: unknown) => void): void;
  off?(event: string, handler: (payload: unknown) => void): void;
}

function readHotContext(): ViteHotContextLike | undefined {
  const hot = (import.meta as ImportMeta & { hot?: ViteHotContextLike }).hot;
  return typeof hot?.on === "function" ? hot : undefined;
}

export interface DevAssetHotReloadConnection {
  /** 是否真实接入 vite HMR(false = 非开发服务器,事件不会到达)。 */
  readonly connected: boolean;
  dispose(): void;
}

/**
 * 订阅资产变更事件并去抖转发;返回连接句柄(组件卸载时 dispose)。
 * payload 来自插件侧 { urls: string[] };缺省去抖 200ms,合并同窗口多文件事件。
 * hot context 可注入(vite dev 用 import.meta.hot;测试注入假上下文)。
 */
export function subscribeAssetChangedEvents(
  hot: ViteHotContextLike,
  onAssetsChanged: (detail: AssetChangedDetail) => void,
  debounceMs = 200,
): () => void {
  const queuedUrls = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (queuedUrls.size === 0) return;
    const urls = [...queuedUrls];
    queuedUrls.clear();
    onAssetsChanged({ urls });
  };
  const handler = (payload: unknown) => {
    const detail = payload as Partial<AssetChangedDetail> | undefined;
    if (!detail || !Array.isArray(detail.urls)) return;
    for (const url of detail.urls) if (typeof url === "string" && url) queuedUrls.add(url);
    timer ??= setTimeout(flush, debounceMs);
  };
  hot.on(ASSET_CHANGED_EVENT, handler);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    hot.off?.(ASSET_CHANGED_EVENT, handler);
  };
}

export function connectDevAssetHotReload(
  onAssetsChanged: (detail: AssetChangedDetail) => void,
  debounceMs = 200,
): DevAssetHotReloadConnection {
  const hot = readHotContext();
  if (!hot) return { connected: false, dispose: () => {} };
  const unsubscribe = subscribeAssetChangedEvents(hot, onAssetsChanged, debounceMs);
  return { connected: true, dispose: unsubscribe };
}
