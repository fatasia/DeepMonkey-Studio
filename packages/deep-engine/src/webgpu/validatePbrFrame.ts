import type { DeviceSession } from "./deviceSession.js";
import type { FrameMetrics } from "./pbrRendererTypes.js";

/** 刀 C 首帧归因:validateFrame 段级 mark(渲染编码 / 校验作用域 / 队列排空)。 */
function markValidate(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(`deep-webgpu:validate-${name}`);
  }
}

/**
 * popErrorScope 超时上限。历史语义保留:pop 在"scope 内发起的操作全部完成"才 resolve,
 * scope 期间存在未结算的异步管线创建时会合法地无限等待(2026-10-06 shadow 分级真机
 * 卡死实证,Chromium 40775455 同族)。当前实现已不使用 error scope(见下),该上限保留
 * 给未来恢复 scope 模式的场景。
 */
const POP_ERROR_SCOPE_TIMEOUT_MS = 30_000;

async function popErrorScopeWithTimeout(device: GPUDevice): Promise<GPUError | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `popErrorScope 未在 ${POP_ERROR_SCOPE_TIMEOUT_MS}ms 内结算:scope 期间存在未完成的 GPU 异步操作(管线创建/查询),按首帧校验失败处理`)), POP_ERROR_SCOPE_TIMEOUT_MS);
  });
  try { return await Promise.race([device.popErrorScope(), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * 首帧校验窗口(2026-10-06 重构):popErrorScope 模式的 resolve 等待 scoped operations
 * 全部结算,实测恒 220-240ms(Dawn 校验消息管道周期,与工作量弱相关)——首帧 500 的
 * 纯固定税。等价替代:不 push scope 时所有 validation error 走 device 的
 * uncapturederror 事件——提交前挂监听、排空后让 pending 事件任务先行(一个宏任务),
 * 再判定捕获。fail-closed 语义不变:任何 error(含 OOM)即 invalidate+throw;
 * 无事件=通过。"error-scope-cleared" mark 名保留(验证窗口关闭点,探针断言兼容)。
 */
async function validateByUncapturedErrorWindow(device: GPUDevice, render: () => FrameMetrics | undefined): Promise<FrameMetrics | undefined> {
  let captured: string | undefined;
  const onUncaptured = (event: GPUUncapturedErrorEvent) => {
    const error = event.error;
    // GPU 全局类在非 WebGPU 环境(测试/worker 预热期)不存在——nameof 兜底,不裸 instanceof。
    const name = error?.constructor?.name ?? "GPUError";
    captured ??= `${name}: ${error?.message ?? "uncaptured GPU error"}`;
  };
  device.addEventListener("uncapturederror", onUncaptured);
  try {
    const frame = render();
    markValidate("render-encoded");
    // 刀 C 首帧:先排空队列再判窗。onSubmittedWorkDone 与 uncapturederror 派发是两条
    // 任务队列,排空 resolve 可能先到——零延时宏任务让 pending 事件先行再收窗。
    await device.queue.onSubmittedWorkDone();
    markValidate("queue-drained");
    await new Promise(resolve => setTimeout(resolve, 0));
    return frame;
  } finally {
    device.removeEventListener("uncapturederror", onUncaptured);
    markValidate("error-scope-cleared");
    if (captured !== undefined) throw new Error(captured);
  }
}

/** 首帧校验与排空只用于准备/诊断，不进入正常动画热路。 */
export async function validatePbrFrame(session: DeviceSession,
  render: () => FrameMetrics | undefined, invalidate: () => void): Promise<FrameMetrics> {
  if (session.state !== "ready") throw new Error("Renderer is not ready.");
  markValidate("start");
  try {
    const frame = await validateByUncapturedErrorWindow(session.device, render);
    if (!frame) throw new Error("Surface is hidden or GPU device is unavailable.");
    if (session.state !== "ready" || session.diagnostics.length) throw new Error("GPU first frame failed; inspect device diagnostics.");
    return frame;
  } catch (error) {
    invalidate();
    throw error;
  }
}

export { popErrorScopeWithTimeout, POP_ERROR_SCOPE_TIMEOUT_MS };
