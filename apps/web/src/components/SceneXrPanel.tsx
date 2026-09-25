import { X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { xrBackendLabel, xrEntryBlockReasons } from "../viewer/xrSession";
import type { RendererBackend } from "../viewer/ViewerEngine";

export type SceneXrMode = "immersive-vr" | "immersive-ar";

export interface SceneXrCapabilities {
  checking: boolean;
  secure: boolean;
  webxr: boolean;
  vr: boolean;
  ar: boolean;
}

interface SceneXrPanelProps {
  locale: AppLocale;
  /** 引擎实际承载 XR 的作者渲染后端（非用户偏好）。 */
  rendererBackend: RendererBackend;
  capabilities: SceneXrCapabilities;
  activeMode?: SceneXrMode | undefined;
  onStart: (mode: SceneXrMode) => void;
  onEnd: () => void;
  onClose: () => void;
}

export function SceneXrPanel(props: SceneXrPanelProps) {
  const { locale, capabilities, activeMode } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  // 与引擎 startXR 前置门槛同一事实源：不支持时展示原因而不是只给一个不可点的按钮。
  const backendBlockReasons = xrEntryBlockReasons({
    secureContext: capabilities.secure,
    webxrApi: capabilities.webxr,
    authorBackend: props.rendererBackend,
  });

  return (
    <>
      <div
        ref={drag.panelRef}
        style={drag.style}
        className="xr-panel"
        aria-label={tr(locale, "沉浸式体验", "Immersive experience")}
      >
        <header
          data-drag-handle="true"
          title={tr(locale, "拖动标题栏移动沉浸式面板", "Drag the title bar to move the immersive panel")}
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
        >
          <div>
            <strong>VR / AR</strong>
            <small>
              {tr(locale, "WebXR 设备能力", "WebXR device capabilities")}
            </small>
          </div>
          <button
            onClick={activeMode ? props.onEnd : props.onClose}
            aria-label={tr(
              locale,
              "关闭沉浸式体验",
              "Close immersive experience",
            )}
          >
            <X size={14} />
          </button>
        </header>
        <div className="xr-requirements">
          <span className={capabilities.secure ? "ok" : "bad"}>
            {capabilities.secure ? "✓" : "!"} HTTPS
          </span>
          <span className={capabilities.webxr ? "ok" : "bad"}>
            {capabilities.webxr ? "✓" : "!"} WebXR
          </span>
          <span className={props.rendererBackend === "webgl" ? "ok" : "bad"}>
            {props.rendererBackend === "webgl" ? "✓" : "!"} {xrBackendLabel(props.rendererBackend)}
          </span>
        </div>
        <div className="xr-mode-grid">
          <XrModeCard
            locale={locale}
            kind="VR"
            title={tr(locale, "虚拟现实", "Virtual reality")}
            description={tr(
              locale,
              "头显 · 空间漫游",
              "Headset · immersive walkthrough",
            )}
            checking={capabilities.checking}
            supported={capabilities.vr}
            disabled={Boolean(activeMode) || backendBlockReasons.length > 0}
            onStart={() => props.onStart("immersive-vr")}
          />
          <XrModeCard
            locale={locale}
            kind="AR"
            title={tr(locale, "增强现实", "Augmented reality")}
            description={tr(
              locale,
              "Android 移动设备 · 现实叠加",
              "Android mobile · world overlay",
            )}
            checking={capabilities.checking}
            supported={capabilities.ar}
            disabled={Boolean(activeMode) || backendBlockReasons.length > 0}
            onStart={() => props.onStart("immersive-ar")}
          />
        </div>
        {activeMode && (
          <button className="xr-exit" onClick={props.onEnd}>
            {tr(locale, "退出当前 XR 会话", "Exit current XR session")}
          </button>
        )}
        {backendBlockReasons.length > 0 && !capabilities.checking && (
          <p role="note" data-testid="xr-block-reasons">
            {backendBlockReasons.map((reason, index) => (
              <span key={reason}>
                {index > 0 && "；"}
                {tr(locale, reason, XR_REASON_I18N[reason] ?? reason)}
              </span>
            ))}
          </p>
        )}
        {!capabilities.checking && (!capabilities.vr || !capabilities.ar) && backendBlockReasons.length === 0 && (
          <p>
            {tr(
              locale,
              "桌面浏览器通常只能检测 VR 头显；AR 需支持 WebXR 的 Android 设备。自签名证书必须先在设备上信任。",
              "Desktop browsers usually require a connected VR headset; AR requires a WebXR-capable Android device. Trust the self-signed certificate on the device first.",
            )}
          </p>
        )}
      </div>
      {activeMode && (
        <div className="xr-session-hud">
          <div>
            <strong>
              {activeMode === "immersive-vr" ? "VR" : "AR"}{" "}
              {tr(locale, "运行中", "active")}
            </strong>
            <small>
              {activeMode === "immersive-vr"
                ? tr(
                    locale,
                    "左摇杆移动 · 右摇杆转向 · B/Y 退出",
                    "Left stick move · right stick turn · B/Y exit",
                  )
                : tr(
                    locale,
                    "点击退出返回编辑器",
                    "Exit to return to the editor",
                  )}
            </small>
          </div>
          <button onClick={props.onEnd}>{tr(locale, "退出", "Exit")}</button>
        </div>
      )}
    </>
  );
}

function XrModeCard(props: {
  locale: AppLocale;
  kind: "VR" | "AR";
  title: string;
  description: string;
  checking: boolean;
  supported: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <article>
      <span className="xr-mode-icon">{props.kind}</span>
      <div>
        <strong>{props.title}</strong>
        <small>{props.description}</small>
      </div>
      <button
        disabled={props.checking || !props.supported || props.disabled}
        onClick={props.onStart}
      >
        {props.checking
          ? "…"
          : props.supported
            ? tr(props.locale, "进入", "Enter")
            : tr(props.locale, "不支持", "Unavailable")}
      </button>
    </article>
  );
}

/** xrEntryBlockReasons 产出的原因文案英文对照，与诊断面板保持同一口径。 */
const XR_REASON_I18N: Record<string, string> = {
  "XR 会话仅 Three WebGL 渲染后端支持；Deep WebGPU 激活期间不可用":
    "XR sessions are supported only on the Three WebGL backend; unavailable while Deep WebGPU is active",
  "需要 HTTPS 或 localhost 安全上下文": "Requires HTTPS or a localhost secure context",
  "浏览器未暴露 WebXR API（navigator.xr）": "The browser does not expose the WebXR API (navigator.xr)",
};
