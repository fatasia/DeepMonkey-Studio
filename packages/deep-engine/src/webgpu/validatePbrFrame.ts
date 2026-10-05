import type { DeviceSession } from "./deviceSession.js";
import type { FrameMetrics } from "./pbrRendererTypes.js";

/** 刀 C 首帧归因:validateFrame 段级 mark(渲染编码 / 校验作用域 / 队列排空)。 */
function markValidate(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(`deep-webgpu:validate-${name}`);
  }
}

/**
 * popErrorScope 超时上限。规范语义:pop 在"scope 内发起的操作全部完成"才 resolve——
 * scope 期间存在未结算的异步管线创建时它会合法地无限等待(2026-10-06 shadow 分级
 * 真机卡死实证,Chromium 40775455 同族)。任何 GPU hang 都不该无限挂死首帧链路:
 * 超时按校验失败处理(fail-closed,与校验错误同路径),错误信息带判据供归因。
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

/** 首帧校验与排空只用于准备/诊断，不进入正常动画热路。 */
export async function validatePbrFrame(session: DeviceSession,
  render: () => FrameMetrics | undefined, invalidate: () => void): Promise<FrameMetrics> {
  if (session.state !== "ready") throw new Error("Renderer is not ready.");
  markValidate("start");
  session.device.pushErrorScope("validation");
  let frame: FrameMetrics | undefined;
  try { frame = render(); }
  finally {
    markValidate("render-encoded");
    // 刀 C 首帧:先排空队列再弹校验作用域。popErrorScope 等待"作用域内提交的
    // GPU 工作完成且校验消息回传"(实测恒 ~220-240ms,与工作量弱相关);
    // onSubmittedWorkDone 排空后该等待已满足,弹作用域应即时结算。
    // 校验顺序语义不变:仍先确认 GPU 工作(含本帧)完成,再断言零校验错误。
    await session.device.queue.onSubmittedWorkDone();
    markValidate("queue-drained");
    const error = await popErrorScopeWithTimeout(session.device);
    markValidate("error-scope-cleared");
    if (error) { invalidate(); throw new Error(error.message); }
  }
  if (!frame) throw new Error("Surface is hidden or GPU device is unavailable.");
  if (session.state !== "ready" || session.diagnostics.length) throw new Error("GPU first frame failed; inspect device diagnostics.");
  return frame;
}
