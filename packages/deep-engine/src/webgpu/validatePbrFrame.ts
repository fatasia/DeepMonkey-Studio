import type { DeviceSession } from "./deviceSession.js";
import type { FrameMetrics } from "./pbrRendererTypes.js";

/** 首帧校验与排空只用于准备/诊断，不进入正常动画热路。 */
export async function validatePbrFrame(session: DeviceSession,
  render: () => FrameMetrics | undefined, invalidate: () => void): Promise<FrameMetrics> {
  if (session.state !== "ready") throw new Error("Renderer is not ready.");
  session.device.pushErrorScope("validation");
  let frame: FrameMetrics | undefined;
  try { frame = render(); }
  finally {
    const error = await session.device.popErrorScope();
    if (error) { invalidate(); throw new Error(error.message); }
  }
  if (!frame) throw new Error("Surface is hidden or GPU device is unavailable.");
  await session.device.queue.onSubmittedWorkDone();
  if (session.state !== "ready" || session.diagnostics.length) throw new Error("GPU first frame failed; inspect device diagnostics.");
  return frame;
}
