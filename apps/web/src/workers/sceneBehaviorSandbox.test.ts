import { describe, expect, it, vi } from "vitest";
import { assertNoDynamicModuleImports, hardenSceneBehaviorWorkerGlobals } from "./sceneBehaviorSandbox";

describe("sceneBehaviorSandbox", () => {
  it("保留私有宿主协议发送器并锁住用户可见的直连通道", () => {
    const nativePostMessage = vi.fn();
    const scope: Record<string, unknown> = {
      postMessage: nativePostMessage,
      fetch: vi.fn(),
      WebSocket: vi.fn(),
      EventSource: vi.fn(),
      importScripts: vi.fn(),
      indexedDB: {},
      close: vi.fn(),
    };

    const sendToHost = hardenSceneBehaviorWorkerGlobals(scope);
    sendToHost({ type: "behavior.ready" });

    expect(nativePostMessage).toHaveBeenCalledWith({ type: "behavior.ready" });
    for (const name of ["postMessage", "fetch", "WebSocket", "EventSource", "importScripts"]) {
      expect(() => (scope[name] as () => void)()).toThrow(/项目脚本不能直接/);
      expect(Object.getOwnPropertyDescriptor(scope, name)).toMatchObject({ configurable: false, writable: false });
    }
    expect(() => (scope.indexedDB as () => void)()).toThrow("项目脚本不能直接访问 indexedDB 持久存储");
    expect(() => (scope.close as () => void)()).toThrow("项目脚本不能主动关闭行为 Worker");
    expect(Reflect.set(scope, "postMessage", vi.fn())).toBe(false);
  });

  it("拒绝主脚本和缓存依赖中的动态 import，但保留静态 ESM 导入", async () => {
    await expect(assertNoDynamicModuleImports(
      'export async function onStart() { return import("https://example.com/runtime.js"); }',
      "项目脚本",
    )).rejects.toThrow("项目脚本不允许动态 import");
    await expect(assertNoDynamicModuleImports(
      'export const load = () => import("./hidden-chunk.js");',
      "依赖 virtual-controls：",
    )).rejects.toThrow("依赖 virtual-controls：不允许动态 import");
    await expect(assertNoDynamicModuleImports(
      'import { Vector3 } from "three"; export const origin = new Vector3();',
      "项目脚本",
    )).resolves.toBeUndefined();
  });
});
