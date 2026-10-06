/**
 * 开发服务器资产热重载插件(vite dev 专用,零新依赖)。
 *
 * vite 自带 chokidar 监听器;本插件把 API 端本地资产存储目录(<dataDir>/projects,
 * 本地开发默认 <repoRoot>/data/projects)挂进同一监听器,模型/纹理文件落盘后把
 * 存储键映射回 `/assets/...` URL,经 vite 原生 HMR ws 推给浏览器,由
 * src/studio/devAssetHotReloadBridge.ts 消费并触发引擎热替换。
 *
 * 边界如实声明:目录不存在(远程/MinIO 对象存储、未初始化 data 目录)时插件
 * no-op,不报错——运行中热重载仍有浮窗"重新加载"按钮兜底。
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** 模型与纹理的运行时可热换扩展名;与 API 端本地存储产物一致,不含 .gz 压缩伴生。 */
const WATCHED_EXTENSIONS = new Set([
  // 模型几何与清单
  ".glb", ".gltf", ".fbx", ".obj", ".stl", ".3mf", ".dae", ".3ds", ".dxf",
  ".ifc", ".fragments", ".usd", ".usda", ".usdc", ".usdz", ".urdf", ".json",
  // 纹理与图像
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ktx2", ".exr", ".hdr", ".avif", ".bmp",
]);

export const ASSET_CHANGED_EVENT = "bim-studio:asset-changed";

export interface AssetChangedDetail {
  readonly urls: readonly string[];
}

/** 解析监听根:优先 BIM_STUDIO_HOT_ASSET_DIR(相对仓库根),默认 <repoRoot>/data/projects;缺失返回 undefined。 */
export function resolveAssetWatchRoot(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url))),
): string | undefined {
  const configured = environment.BIM_STUDIO_HOT_ASSET_DIR?.trim();
  const root = configured
    ? resolve(projectRoot, configured)
    : resolve(projectRoot, "data", "projects");
  return existsSync(root) ? root : undefined;
}

/** 绝对路径 → 变更事件;非监听扩展/根外文件/gzip 伴生返回 undefined。 */
export function assetChangedEventFromPath(watchRoot: string, file: string): AssetChangedDetail["urls"][number] | undefined {
  if (!file.startsWith(watchRoot + sep)) return undefined;
  const extension = file.slice(file.lastIndexOf(".")).toLocaleLowerCase();
  if (!WATCHED_EXTENSIONS.has(extension) || file.toLocaleLowerCase().endsWith(".gz")) return undefined;
  const key = file.slice(watchRoot.length + sep.length).split(sep).join("/");
  return `/assets/projects/${key}`;
}

interface WatcherLike {
  add(path: string): unknown;
  on(event: "add" | "change", listener: (file: string) => void): unknown;
}

interface WsServerLike {
  send(event: string, payload: unknown): void;
}

export interface AssetHotReloadPluginOptions {
  /** 测试注入;生产路径由 resolveAssetWatchRoot 推导。 */
  watchRoot?: string;
  /** 聚合窗口毫秒数(同一次保存常伴随 geometry+lods 多文件落盘)。 */
  debounceMs?: number;
}

/** 把监听回调接成 ws 推送;拆出纯函数便于单测(mock watcher/ws)。 */
export function watchAssetsAndBroadcast(watchRoot: string, watcher: WatcherLike, broadcast: (detail: AssetChangedDetail) => void, debounceMs = 120): void {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (pending.size === 0) return;
    const urls = [...pending];
    pending = new Set();
    broadcast({ urls });
  };
  watcher.add(watchRoot);
  const schedule = (file: string) => {
    const url = assetChangedEventFromPath(watchRoot, file);
    if (!url) return;
    pending.add(url);
    timer ??= setTimeout(flush, debounceMs);
  };
  watcher.on("add", schedule);
  watcher.on("change", schedule);
}

export function assetHotReloadPlugin(options: AssetHotReloadPluginOptions = {}): Plugin {
  return {
    name: "bim-studio-asset-hot-reload",
    apply: "serve",
    configureServer(server) {
      const configured = options.watchRoot ?? resolveAssetWatchRoot();
      const root = configured && existsSync(configured) ? configured : undefined;
      if (!root) {
        server.config.logger.info(
          "bim-studio: 本地资产目录不存在，跳过资产热重载监听（浮窗“重新加载”按钮仍可用）",
          { timestamp: true },
        );
        return;
      }
      watchAssetsAndBroadcast(root, server.watcher as unknown as WatcherLike, detail => {
        server.ws.send(ASSET_CHANGED_EVENT, detail);
      }, options.debounceMs);
    },
  };
}
