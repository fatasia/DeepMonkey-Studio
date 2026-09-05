import { init as initializeModuleLexer, parse as parseModule } from "es-module-lexer";

type SandboxGlobal = Record<string, unknown>;
type ProtocolSender = (message: unknown) => void;

/** Keep the documented ctx.self handle distinct from the Worker global self. */
export function assertBehaviorSourceAccess(source: string, networkAllowed: boolean): void {
  const accessSource = source.replace(/\.\s*self\b/g, ".target");
  const host = /\b(?:window|document|localStorage|sessionStorage|indexedDB|caches|navigator|SharedWorker|Worker|importScripts|postMessage|close|globalThis|self|eval|Function)\b/;
  const network = /\b(?:fetch|XMLHttpRequest|WebSocket|WebSocketStream|EventSource|WebTransport|BroadcastChannel|RTCPeerConnection)\b/;
  if (host.test(accessSource) || (!networkAllowed && network.test(source))) {
    throw new Error("脚本请求了 Worker 沙箱中未授权的浏览器或网络能力");
  }
}

const BLOCKED_GLOBALS = [
  "postMessage",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  "WebTransport",
  "BroadcastChannel",
  "RTCPeerConnection",
  "indexedDB",
  "caches",
  "Worker",
  "SharedWorker",
  "importScripts",
  "close",
] as const;

/**
 * 保存宿主协议通道后锁住用户代码可见的直连能力。
 *
 * 这是一层兼容性硬化，并非可信代码安全边界：Dedicated Worker 仍共享浏览器
 * JavaScript Realm 的反射能力。真正运行第三方敌对代码时，还需要独立源 CSP、
 * SES/QuickJS 等更强隔离。项目脚本的联网必须经过 studio.net，便于鉴权和审计。
 */
export function hardenSceneBehaviorWorkerGlobals(scope: SandboxGlobal): ProtocolSender {
  const nativePostMessage = Reflect.get(scope, "postMessage");
  if (typeof nativePostMessage !== "function") throw new Error("Worker 宿主协议通道不可用");
  const sendToHost = nativePostMessage.bind(scope) as ProtocolSender;

  for (const name of BLOCKED_GLOBALS) {
    const blocked = () => {
      if (name === "postMessage") throw new Error("项目脚本不能直接访问 Worker 宿主协议通道");
      if (name === "indexedDB" || name === "caches") throw new Error(`项目脚本不能直接访问 ${name} 持久存储`);
      if (name === "close") throw new Error("项目脚本不能主动关闭行为 Worker");
      throw new Error(`项目脚本不能直接使用 ${name}；联网请通过 studio.net`);
    };
    try {
      Object.defineProperty(scope, name, {
        configurable: false,
        enumerable: false,
        value: blocked,
        writable: false,
      });
    } catch {
      throw new Error(`Worker 无法锁定 ${name}，已拒绝启动脚本沙箱`);
    }
  }
  return sendToHost;
}

/** 动态 import 会跳过项目依赖锁定与完整性校验，因此主脚本和依赖代码都必须拒绝。 */
export async function assertNoDynamicModuleImports(source: string, label: string): Promise<void> {
  await initializeModuleLexer;
  const [imports] = parseModule(source);
  if (imports.some((entry) => entry.d >= 0)) {
    throw new Error(`${label}不允许动态 import；请在项目依赖中锁定版本并使用顶部静态 import`);
  }
}
