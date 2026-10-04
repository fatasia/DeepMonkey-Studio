import type { DeviceSession } from "./deviceSession.js";
import type { FrameMetrics } from "./pbrRendererTypes.js";

/** 刀 C 首帧归因:validateFrame 段级 mark(渲染编码 / 校验作用域 / 队列排空)。 */
function markValidate(name: string): void {
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(`deep-webgpu:validate-${name}`);
  }
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
    const error = await session.device.popErrorScope();
    markValidate("error-scope-cleared");
    if (error) { invalidate(); throw new Error(error.message); }
  }
  if (!frame) throw new Error("Surface is hidden or GPU device is unavailable.");
  if (session.state !== "ready" || session.diagnostics.length) throw new Error("GPU first frame failed; inspect device diagnostics.");
  return frame;
}
