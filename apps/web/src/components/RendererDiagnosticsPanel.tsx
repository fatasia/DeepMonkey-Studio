import { Check, Cpu, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { RendererBackend } from "../viewer/ViewerEngine";
import type { RendererCapabilityProbe, RendererReadiness } from "../rendererCapabilities";
import { translate as tr, type AppLocale } from "../i18n";

interface Props {
  locale: AppLocale;
  current: RendererBackend;
  switching: boolean;
  checking: boolean;
  probe: RendererCapabilityProbe | undefined;
  readiness: RendererReadiness[];
  onClose: () => void;
  onRefresh: () => void;
  onSwitch: (backend: RendererBackend) => void;
}

export function RendererDiagnosticsPanel(props: Props) {
  return <section className="renderer-diagnostics-panel" aria-label={tr(props.locale, "渲染能力诊断", "Renderer diagnostics")}>
    <header><span><strong>{tr(props.locale, "渲染能力诊断", "Renderer diagnostics")}</strong><small>{tr(props.locale, "切换前预检，失败自动恢复场景", "Preflight before switching; restore the scene on failure")}</small></span><button aria-label={tr(props.locale, "关闭", "Close")} onClick={props.onClose}><X size={14} /></button></header>
    {props.checking ? <div className="renderer-diagnostics-loading"><LoaderCircle className="spin" size={17} /><span>{tr(props.locale, "正在检测浏览器、显卡和项目能力…", "Checking browser, GPU and project capabilities…")}</span></div> : <>
      <div className="renderer-device-card"><Cpu size={17} /><span><strong>{props.probe?.adapterName || tr(props.locale, "图形设备", "Graphics device")}</strong><small>{props.probe?.maxTextureDimension2D ? `Max texture ${props.probe.maxTextureDimension2D}px` : tr(props.locale, "浏览器未公开设备名称", "Device name is not exposed by the browser")}</small></span><button title={tr(props.locale, "重新检测", "Check again")} onClick={props.onRefresh}><RefreshCw size={13} /></button></div>
      <div className="renderer-option-list">
        {props.readiness.map((item) => <article key={item.backend} className={`${item.level} ${props.current === item.backend ? "current" : ""}`}>
          <div className="renderer-option-title"><span>{item.level === "ready" ? <Check size={14} /> : item.level === "limited" ? <TriangleAlert size={14} /> : <X size={14} />}<strong>{item.backend === "webgl" ? "WebGL 2" : "WebGPU"}</strong></span>{props.current === item.backend && <small>{tr(props.locale, "当前", "Current")}</small>}</div>
          <p>{trReadiness(props.locale, item)}</p>
          <ul>{item.details.map((detail) => <li key={detail}>{trDetail(props.locale, detail)}</li>)}</ul>
          <button disabled={!item.ready || props.switching || props.current === item.backend} onClick={() => props.onSwitch(item.backend)}>{props.current === item.backend ? tr(props.locale, "正在使用", "In use") : !item.ready ? tr(props.locale, "不可用", "Unavailable") : item.backend === "webgpu" ? tr(props.locale, "切换并保留场景", "Switch and preserve scene") : tr(props.locale, "切换到兼容模式", "Switch to compatibility")}</button>
        </article>)}
      </div>
      <footer><ShieldCheck size={14} /><span>{tr(props.locale, "WebGPU 仍为实验模式；切换会先保存内存快照，初始化失败时自动回到 WebGL 2。", "WebGPU remains experimental. Switching keeps an in-memory snapshot and falls back to WebGL 2 if initialization fails.")}</span></footer>
    </>}
  </section>;
}

function trReadiness(locale: AppLocale, item: RendererReadiness): string {
  const translations: Record<string, string> = {
    "生产兼容，功能完整": "Production-compatible and feature-complete",
    "当前环境无法创建 WebGL 2 上下文": "This environment cannot create a WebGL 2 context",
    "当前设备不可用": "Unavailable on this device",
    "可试用，存在项目限制": "Available for trial with project limitations",
    "可试用，未发现项目限制": "Available for trial; no project limitations found"
  };
  return locale === "zh-CN" ? item.summary : translations[item.summary] ?? item.summary;
}

function trDetail(locale: AppLocale, detail: string): string {
  const translations: Record<string, string> = {
    "当前后处理管线完整可用": "Current post-processing pipeline is fully available",
    "模型、材质、拾取与动画完整可用": "Models, materials, picking and animation are fully available",
    "作为生产兼容后端保留": "Retained as the production compatibility backend",
    "需要 HTTPS 或 localhost 安全上下文": "Requires HTTPS or a localhost secure context",
    "安全上下文可用": "Secure context available",
    "浏览器未暴露 WebGPU API": "The browser does not expose WebGPU",
    "未找到可用的高性能 GPU 适配器": "No high-performance GPU adapter is available",
    "GPU 适配器可用": "GPU adapter available",
    "当前后处理将暂停显示，配置会保留": "Post-processing display pauses, but its configuration is preserved",
    "当前项目未发现已知显示限制": "No known display limitations were found for this project"
  };
  return locale === "zh-CN" ? detail : translations[detail] ?? detail;
}
