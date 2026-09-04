import { useState } from "react";
import { Cloud, EyeOff, Gauge, Globe2, LoaderCircle, MonitorUp, Rocket, Ruler, ShieldCheck, Sparkles } from "lucide-react";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

type PublicationMode = NonNullable<SceneSnapshot["publicationMode"]>;
type PublicationPerformance = NonNullable<SceneSnapshot["publicationPerformance"]>;

interface ScenePublicationDialogProps {
  locale: AppLocale;
  sceneName: string;
  mode: PublicationMode;
  performance: PublicationPerformance;
  defaultToolbarVisible: boolean;
  cloudConfigured: boolean | undefined;
  busy?: boolean;
  onModeChange: (mode: PublicationMode) => void;
  onPerformanceChange: (performance: PublicationPerformance) => void;
  onCancel: () => void;
  onPublish: (toolbarVisible: boolean) => void;
}

/** 管理中心与编辑器共用同一发布决策 UI，避免渲染策略和保真文案分叉。 */
export function ScenePublicationDialog(props: ScenePublicationDialogProps) {
  const { locale } = props;
  const [toolbarVisible, setToolbarVisible] = useState(props.defaultToolbarVisible);
  return (
    <div className="dialog-backdrop" onMouseDown={() => !props.busy && props.onCancel()}>
      <section
        className="dialog publication-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="publication-dialog-header">
          <span className="publication-dialog-icon"><Rocket size={18} /></span>
          <div>
            <h2>{tr(locale, "发布运行版本", "Publish runtime version")}</h2>
            <p title={tr(locale, "当前草稿将冻结为可回退版本", "The current draft becomes a restorable version")}>{props.sceneName} · {tr(locale, "可回退的运行版本", "Restorable runtime version")}</p>
          </div>
        </header>
        <div className="publication-dialog-scroll">
          <div className="publication-section-heading" title={tr(locale, "运行后端可再次发布切换", "Republish later to switch runtime")}>
            <div><strong>{tr(locale, "选择交付方式", "Choose delivery")}</strong></div>
            <span><ShieldCheck size={13} />{tr(locale, "版本隔离", "Version isolated")}</span>
          </div>
          <div className="publication-mode-options">
            <ModeButton
              icon={<Globe2 size={17} />}
              active={props.mode === "webgl"}
              badge={tr(locale, "兼容优先", "Compatible")}
              title={tr(locale, "WebGL 发布", "WebGL publish")}
              description={tr(locale, "固定 WebGL 2，本地渲染，适合普通办公终端和系统嵌入。", "Fixed WebGL 2 local rendering for broad device and embedding support.")}
              onClick={() => props.onModeChange("webgl")}
            />
            <ModeButton
              icon={<Sparkles size={17} />}
              active={props.mode === "webgpu-preferred"}
              badge={tr(locale, "性能优先", "Performance")}
              title={tr(locale, "WebGPU 优先", "WebGPU preferred")}
              description={tr(locale, "支持时启用高级管线；不支持或画质不等价时回退 WebGL 并说明原因。", "Uses the advanced pipeline when supported; otherwise falls back to WebGL with a visible reason.")}
              onClick={() => props.onModeChange("webgpu-preferred")}
            />
            <ModeButton
              icon={<Cloud size={17} />}
              active={props.mode === "cloud"}
              disabled={props.cloudConfigured !== true}
              badge={tr(locale, "弱终端", "Thin client")}
              title={tr(locale, "云渲染", "Cloud rendering")}
              description={cloudDescription(locale, props.cloudConfigured)}
              onClick={() => props.onModeChange("cloud")}
            />
          </div>
          <div className="publication-section-heading compact" title={tr(locale, "模型几何与纹理质量不会被重写", "Model geometry and textures are never rewritten")}>
            <div><strong>{tr(locale, "终端性能策略", "Device performance policy")}</strong></div>
          </div>
          <div className="publication-performance-options">
            <ModeButton
              icon={<MonitorUp size={16} />}
              active={props.performance === "standard"}
              title={tr(locale, "保持发布画质", "Keep published quality")}
              description={tr(locale, "严格使用作者效果；性能不足时给出诊断，不自动进入极速模式。", "Keeps authored effects; diagnoses pressure without entering fast mode automatically.")}
              onClick={() => props.onPerformanceChange("standard")}
            />
            <ModeButton
              icon={<Gauge size={16} />}
              active={props.performance === "fast"}
              badge={tr(locale, "发布者授权", "Publisher allows")}
              title={tr(locale, "允许极速模式", "Allow fast mode")}
              description={tr(locale, "低配终端持续卡顿时可自动启用；优先减轻阴影、后处理与刷新压力，恢复后自动退出。", "May activate under sustained pressure; reduces shadow, post-processing and refresh cost, then restores.")}
              onClick={() => props.onPerformanceChange("fast")}
            />
          </div>
          <div className="publication-section-heading compact" title={tr(locale, "只影响发布浏览页，不开放模型编辑能力", "Affects only the published viewer and never enables model editing")}>
            <div>
              <strong>{tr(locale, "浏览工具栏", "Viewer toolbar")}</strong>
            </div>
          </div>
          <div className="publication-toolbar-options">
            <ModeButton
              icon={<Ruler size={16} />}
              active={toolbarVisible}
              title={tr(locale, "显示查看工具", "Show viewer tools")}
              description={tr(locale, "允许访客使用适应全部、漫游、测量、剖切、爆炸和场景信息。", "Visitors can fit, navigate, measure, section, explode and inspect scene information.")}
              onClick={() => setToolbarVisible(true)}
            />
            <ModeButton
              icon={<EyeOff size={16} />}
              active={!toolbarVisible}
              title={tr(locale, "隐藏工具栏", "Hide toolbar")}
              description={tr(locale, "用于展厅、嵌入页和只需观看的交付；场景交互仍可正常运行。", "For kiosks, embeds and view-only delivery; authored scene interactions still run.")}
              onClick={() => setToolbarVisible(false)}
            />
          </div>
          <div className="publication-impact-strip">
            <span><ShieldCheck size={14} /><strong>{tr(locale, "发布不会覆盖草稿", "Draft stays editable")}</strong></span>
            <span><MonitorUp size={14} /><strong>{tr(locale, "可恢复历史版本", "Restorable history")}</strong></span>
            <span><Gauge size={14} /><strong>{tr(locale, "运行状态可诊断", "Runtime diagnostics")}</strong></span>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="button" disabled={props.busy} onClick={props.onCancel}>
            {tr(locale, "取消", "Cancel")}
          </button>
          <button
            className="button primary"
            disabled={props.busy || (props.mode === "cloud" && props.cloudConfigured !== true)}
            onClick={() => props.onPublish(toolbarVisible)}
          >
            {props.busy ? <LoaderCircle className="spin" size={14} /> : <Rocket size={14} />}
            {tr(locale, "发布", "Publish")}
          </button>
        </div>
      </section>
    </div>
  );
}

function ModeButton(props: { active: boolean; disabled?: boolean; icon: React.ReactNode; badge?: string; title: string; description: string; onClick: () => void }) {
  // 描述文案进 title 悬浮：卡片保持单行紧凑，说明按需查看（用户 2026-09-04 反馈要求）。
  return (
    <button
      type="button"
      className={props.active ? "active" : ""}
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.description}
      onClick={props.onClick}
    >
      <span className="publication-mode-icon">{props.icon}</span>
      <span className="publication-mode-copy"><strong>{props.title}</strong></span>
      {props.badge && <em>{props.badge}</em>}
    </button>
  );
}

function cloudDescription(locale: AppLocale, configured: boolean | undefined): string {
  if (configured === undefined) return tr(locale, "正在检查云渲染配置…", "Checking cloud configuration…");
  if (!configured) return tr(locale, "请先在云渲染设置完成全局配置", "Complete cloud rendering settings first");
  return tr(
    locale,
    "服务端 GPU 出图，适合超大场景与低配终端；需要稳定网络和已配置 Worker。",
    "Server GPU rendering for large scenes and thin clients; requires a stable network and configured worker."
  );
}
