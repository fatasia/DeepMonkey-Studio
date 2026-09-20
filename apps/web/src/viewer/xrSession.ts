import type { RendererBackend } from "./viewerTypes";

export type XrMode = "immersive-vr" | "immersive-ar";

/**
 * XR 会话失败的统一文案与分档事实源。
 * 引擎 startXR 抛错、SceneXrPanel 状态展示与发布工具栏禁用原因都从这里取，
 * 避免“探测一处口径、面板另一处口径”。
 */

export interface XrEntryGate {
  /** window.isSecureContext。 */
  secureContext: boolean;
  /** Boolean(navigator.xr)。 */
  webxrApi: boolean;
  /** 实际承载 XR 的作者渲染后端（XR 只挂在 THREE.WebGLRenderer 上）。 */
  authorBackend: RendererBackend;
}

export function xrBackendLabel(backend: RendererBackend): string {
  return backend === "webgpu" ? "Deep WebGPU" : "Three WebGL";
}

/** 进入前的静态门槛；返回 undefined 表示可继续请求会话，否则为精确原因。 */
export function describeXrEntryBlock(gate: XrEntryGate): string | undefined {
  if (gate.authorBackend !== "webgl") {
    return `XR 会话仅 Three WebGL 渲染后端支持；当前为${xrBackendLabel(gate.authorBackend)}，请切回 WebGL 后再进入`;
  }
  if (!gate.secureContext) return "XR 需要 HTTPS 或 localhost 安全上下文，当前页面不是安全上下文";
  if (!gate.webxrApi) return "当前浏览器未暴露 WebXR API（navigator.xr），无法进入沉浸式会话";
  return undefined;
}

/** 面板/工具栏的禁用原因；与 describeXrEntryBlock 同一事实，供 UI 分条展示。 */
export function xrEntryBlockReasons(gate: XrEntryGate): string[] {
  const reasons: string[] = [];
  if (gate.authorBackend !== "webgl") {
    reasons.push(`XR 会话仅 Three WebGL 渲染后端支持；Deep WebGPU 激活期间不可用`);
  }
  if (!gate.secureContext) reasons.push("需要 HTTPS 或 localhost 安全上下文");
  if (!gate.webxrApi) reasons.push("浏览器未暴露 WebXR API（navigator.xr）");
  return reasons;
}

function reasonText(reason: unknown): string {
  if (reason instanceof DOMException) return `${reason.name}: ${reason.message}`;
  return reason instanceof Error ? reason.message : String(reason);
}

/** requestSession 被拒绝或抛错时的分档文案。 */
export function describeXrSessionRequestFailure(reason: unknown, mode: XrMode): string {
  const kind = mode === "immersive-vr" ? "VR" : "AR";
  if (reason instanceof DOMException) {
    switch (reason.name) {
      case "NotAllowedError":
        return `进入${kind}被拒绝：未授予沉浸式会话权限（NotAllowedError）`;
      case "SecurityError":
        return `进入${kind}被安全策略阻止（SecurityError）`;
      case "NotSupportedError":
        return `当前设备不支持${kind}会话类型（NotSupportedError）`;
      case "InvalidStateError":
        return `${kind}会话正在进入或刚刚结束，请稍后重试（InvalidStateError）`;
      default:
        break;
    }
  }
  return `进入${kind}失败：${reasonText(reason)}`;
}

/**
 * 会话已建立但渲染器接线失败（setSession/控制器装配等）。
 * 引擎会先回滚到编辑器视图再抛出，因此文案必须告知状态已恢复。
 */
export function describeXrSessionSetupFailure(reason: unknown, mode: XrMode): string {
  const kind = mode === "immersive-vr" ? "VR" : "AR";
  return `${kind}会话初始化失败，已恢复编辑器视图：${reasonText(reason)}`;
}
