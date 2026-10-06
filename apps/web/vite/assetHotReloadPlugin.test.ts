import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ASSET_CHANGED_EVENT,
  assetChangedEventFromPath,
  assetHotReloadPlugin,
  resolveAssetWatchRoot,
  watchAssetsAndBroadcast,
  type AssetChangedDetail,
} from "./assetHotReloadPlugin";
import { ASSET_CHANGED_EVENT as BRIDGE_EVENT } from "../src/studio/devAssetHotReloadBridge";

const tempRoot = mkdtempSync(join(tmpdir(), "asset-hot-reload-"));
beforeAll(() => { mkdirSync(join(tempRoot, "p"), { recursive: true }); mkdirSync(join(tempRoot, "data", "projects"), { recursive: true }); });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

/** Plugin 钩子是 ObjectHook<ServerHook>(函数或 {handler});测试恒为函数形态,经此处统一调用。 */
function callConfigureServer(plugin: { configureServer?: unknown }, server: unknown): void {
  const hook = plugin.configureServer;
  if (typeof hook === "function") { hook(server); return; }
  (hook as { handler: (input: unknown) => void }).handler(server);
}

/** vite 插件:目录解析 → 路径→URL 映射 → 监听聚合推送 → 与客户端桥事件名契约。 */
describe("asset hot reload plugin", () => {
  it("resolves the default data/projects root when it exists", () => {
    const projectRoot = tempRoot;
    const dataProjects = join(projectRoot, "data", "projects");
    mkdirSync(dataProjects, { recursive: true });
    expect(resolveAssetWatchRoot({}, projectRoot)).toBe(dataProjects);
  });

  it("returns undefined when the data directory does not exist (honest no-op)", () => {
    expect(resolveAssetWatchRoot({}, join(tempRoot, "missing-root"))).toBeUndefined();
  });

  it("honours BIM_STUDIO_HOT_ASSET_DIR relative to the project root", () => {
    const root = resolveAssetWatchRoot({ BIM_STUDIO_HOT_ASSET_DIR: join("data", "projects") }, tempRoot);
    expect(root).toBe(join(tempRoot, "data", "projects"));
  });

  it("maps watched files under the root to /assets/projects urls", () => {
    const root = join(tempRoot, "p");
    expect(assetChangedEventFromPath(root, join(root, "m1", "output", "geometry.glb")))
      .toBe("/assets/projects/m1/output/geometry.glb");
    expect(assetChangedEventFromPath(root, join(root, "a1", "tex.png")))
      .toBe("/assets/projects/a1/tex.png");
  });

  it("ignores files outside the root, gzip sidecars and unwatched extensions", () => {
    const root = join(tempRoot, "p");
    expect(assetChangedEventFromPath(root, join(tempRoot, "elsewhere", "a.glb"))).toBeUndefined();
    expect(assetChangedEventFromPath(root, join(root, "m1", "geometry.glb.gz"))).toBeUndefined();
    expect(assetChangedEventFromPath(root, join(root, "m1", "notes.txt"))).toBeUndefined();
  });

  it("aggregates watcher events inside the debounce window into one broadcast", () => {
    vi.useFakeTimers();
    let capture: ((file: string) => void) | undefined;
    const added: string[] = [];
    const watcher = {
      add: (path: string) => { added.push(path); },
      on: (_event: "add" | "change", listener: (file: string) => void) => { capture = listener; },
    };
    const broadcasts: AssetChangedDetail[] = [];
    watchAssetsAndBroadcast(join(tempRoot, "agg"), watcher, detail => broadcasts.push(detail), 50);
    expect(added).toEqual([join(tempRoot, "agg")]);
    capture!(join(tempRoot, "agg", "a", "geometry.glb"));
    capture!(join(tempRoot, "agg", "a", "geometry-low.glb"));
    capture!(join(tempRoot, "agg", "b", "notes.txt"));
    expect(broadcasts).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(broadcasts).toEqual([{ urls: ["/assets/projects/a/geometry.glb", "/assets/projects/a/geometry-low.glb"] }]);
    vi.useRealTimers();
  });

  it("sends the aggregated event through the vite ws server and no-ops without a data dir", () => {
    vi.useFakeTimers();
    const sent: Array<{ event: string; payload: unknown }> = [];
    const server = {
      watcher: { add: vi.fn(), on: vi.fn() },
      ws: { send: (event: string, payload: unknown) => sent.push({ event, payload }) },
      config: { logger: { info: vi.fn() } },
    };
    const plugin = assetHotReloadPlugin({ watchRoot: join(tempRoot, "p") });
    callConfigureServer(plugin, server);
    const listener = server.watcher.on.mock.calls.find(call => call[0] === "change")![1] as (file: string) => void;
    listener(join(tempRoot, "p", "a", "notes.txt"));
    listener(join(tempRoot, "p", "a", "geometry.glb"));
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([{ event: ASSET_CHANGED_EVENT, payload: { urls: ["/assets/projects/a/geometry.glb"] } }]);
    vi.useRealTimers();

    const quietServer = { watcher: { add: vi.fn(), on: vi.fn() }, ws: { send: vi.fn() }, config: { logger: { info: vi.fn() } } };
    callConfigureServer(assetHotReloadPlugin({ watchRoot: join(tempRoot, "definitely-missing") }), quietServer);
    expect(quietServer.watcher.add).not.toHaveBeenCalled();
    expect(quietServer.config.logger.info).toHaveBeenCalled();
  });

  it("keeps the plugin-client event-name contract byte-identical", () => {
    expect(ASSET_CHANGED_EVENT).toBe(BRIDGE_EVENT);
  });
});
