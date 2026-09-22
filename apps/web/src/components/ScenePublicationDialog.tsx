import { useRef, useState } from "react";
import { Cloud, Download, Eye, EyeOff, Gauge, Globe2, LoaderCircle, MonitorUp, Rocket, ShieldCheck, Sparkles, Cpu } from "lucide-react";
import type { SceneSnapshot, ScenePublicationCompatibilityReport } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { usePublicationDialogFocus } from "../hooks/usePublicationDialogFocus";
import type { SceneClientPackageTarget } from "../delivery/sceneClientPackage";
import type { ClientPackageBranding } from "./clientPackageBranding";
import type { useScenePublicationArtifacts } from "../hooks/useScenePublicationArtifacts";
import { ScenePublicationArtifacts } from "./ScenePublicationArtifacts";
import { ScenePublicationFailure } from "./ScenePublicationFailure";
import { ScenePublicationCompatibilityError } from "../delivery/scenePublicationCompatibilityGate";

type PublicationMode = NonNullable<SceneSnapshot["publicationMode"]>;
type PublicationPerformance = NonNullable<SceneSnapshot["publicationPerformance"]>;

interface ScenePublicationDialogProps {
  artifacts?: ReturnType<typeof useScenePublicationArtifacts> | undefined;
  projectId?: string;
  sceneId?: string;
  locale: AppLocale;
  sceneName: string;
  mode: PublicationMode;
  performance: PublicationPerformance;
  defaultToolbarVisible: boolean;
  cloudConfigured: boolean | undefined;
  /** 云渲染不可选时的可见原因；只放 title 悬浮会让用户以为按钮坏了。 */
  cloudHint?: string | undefined;
  busy?: boolean;
  clientTarget?: SceneClientPackageTarget;
  onModeChange: (mode: PublicationMode) => void;
  onPerformanceChange: (performance: PublicationPerformance) => void;
  onCancel: () => void;
  onClientTargetChange?: (target: SceneClientPackageTarget) => void;
  onPublish: (toolbarVisible: boolean, clientTarget: SceneClientPackageTarget, branding?: ClientPackageBranding) => void | Promise<void>;
}

/** 管理中心与编辑器共用同一发布决策 UI，避免渲染策略和保真文案分叉。 */
export function ScenePublicationDialog(props: ScenePublicationDialogProps) {
  const { locale } = props;
  const [toolbarVisible, setToolbarVisible] = useState(props.defaultToolbarVisible);
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [failureReport, setFailureReport] = useState<ScenePublicationCompatibilityReport>();
  const busy = props.busy || submitting;
  const focusRef = usePublicationDialogFocus(Boolean(busy));
  const artifactBusy = props.artifacts?.records.some(record => record.projectId === props.projectId && record.sceneId === props.sceneId && (record.status === "preparing" || record.status === "building"));
  const escapeRef = useDialogEscape(props.onCancel, busy);
  async function submit() {
    if (pending.current || busy || artifactBusy || (props.mode === "cloud" && props.cloudConfigured !== true)) return;
    pending.current = true; setSubmitting(true); setSubmitError(undefined); setFailureReport(undefined);
    try { await props.onPublish(toolbarVisible, props.clientTarget ?? "none"); }
    catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : String(reason));
      if (reason instanceof ScenePublicationCompatibilityError) setFailureReport(reason.report);
    }
    finally { pending.current = false; setSubmitting(false); }
  }
  return (
    <div className="dialog-backdrop" ref={escapeRef} onMouseDown={() => !busy && props.onCancel()}>
      <section
        ref={focusRef}
        tabIndex={-1}
        className="dialog publication-dialog"
        role="dialog"
        aria-label={tr(locale, "发布运行版本", "Publish runtime version")}
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
          <div className="publication-section-heading" title={tr(locale, "运行后端可再次发布切换；发布版本与草稿隔离", "Republish later to switch runtime; publications stay isolated from drafts")}>
            <div><strong>{tr(locale, "选择交付方式", "Choose delivery")}</strong></div>
          </div>
          <div className="publication-mode-options">
            <ModeButton
              icon={<Globe2 size={17} />}
              active={props.mode === "webgl"}
              disabled={Boolean(busy)}
              title="WebGL"
              description={tr(locale, "固定 WebGL 2，本地渲染，适合普通办公终端和系统嵌入。", "Fixed WebGL 2 local rendering for broad device and embedding support.")}
              onClick={() => props.onModeChange("webgl")}
            />
            <ModeButton
              icon={<Sparkles size={17} />}
              active={props.mode === "webgpu-preferred"}
              disabled={Boolean(busy)}
              title="WebGPU"
              description={tr(locale, "支持时启用高级管线；不支持或画质不等价时回退 WebGL 并说明原因。", "Uses the advanced pipeline when supported; otherwise falls back to WebGL with a visible reason.")}
              onClick={() => props.onModeChange("webgpu-preferred")}
            />
            <ModeButton
              icon={<Cloud size={17} />}
              active={props.mode === "cloud"}
              // 未配置时保持可选中：原因在下方提示行可见，用户不应面对一个“灰的点不了”的谜团。
              disabled={Boolean(busy)}
              title={tr(locale, "云渲染", "Cloud rendering")}
              description={cloudDescription(locale, props.cloudConfigured)}
              onClick={() => props.onModeChange("cloud")}
            />
          </div>
          <div className="publication-section-heading compact" title={tr(locale, "模型几何与纹理质量不会被重写；极速模式只降低阴影、后处理与刷新压力", "Model geometry and textures are never rewritten; fast mode only reduces rendering pressure")}>
            <div><strong>{tr(locale, "性能策略", "Performance")}</strong></div>
          </div>
          <div className="publication-performance-options">
            <ModeButton
              icon={<MonitorUp size={16} />}
              active={props.performance === "standard"}
              disabled={Boolean(busy)}
              title={tr(locale, "高画质", "High quality")}
              description={tr(locale, "严格使用作者效果；性能不足时给出诊断，不自动进入极速模式。", "Keeps authored effects; diagnoses pressure without entering fast mode automatically.")}
              onClick={() => props.onPerformanceChange("standard")}
            />
            <ModeButton
              icon={<Gauge size={16} />}
              active={props.performance === "fast"}
              disabled={Boolean(busy)}
              title={tr(locale, "极速模式", "Fast mode")}
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
              icon={<Eye size={16} />}
              active={toolbarVisible}
              disabled={Boolean(busy)}
              title={tr(locale, "显示", "Show")}
              description={tr(locale, "允许访客使用适应全部、漫游、测量、剖切、爆炸和场景信息。", "Visitors can fit, navigate, measure, section, explode and inspect scene information.")}
              onClick={() => setToolbarVisible(true)}
            />
            <ModeButton
              icon={<EyeOff size={16} />}
              active={!toolbarVisible}
              disabled={Boolean(busy)}
              title={tr(locale, "隐藏", "Hide")}
              description={tr(locale, "用于展厅、嵌入页和只需观看的交付；场景交互仍可正常运行。", "For kiosks, embeds and view-only delivery; authored scene interactions still run.")}
              onClick={() => setToolbarVisible(false)}
            />
          </div>
          <div className="publication-section-heading compact" title={tr(locale, "仅发布网页版本，或同时生成可下载的客户端。", "Publish a web version, or also build a downloadable client.")}>
            <div><strong>{tr(locale, "发布方式", "Publication method")}</strong></div>
          </div>
          <div className="publication-mode-options">
            <ModeButton icon={<Download size={16} />} active={(props.clientTarget ?? "none") === "none"} disabled={Boolean(busy)} title={tr(locale, "仅发布", "Publish only")} description={tr(locale, "只创建网页发布版本，不下载客户端包。", "Create the web publication without downloading a client package.")} onClick={() => props.onClientTargetChange?.("none")} />
            <ModeButton icon={<Globe2 size={16} />} active={props.clientTarget === "three-webview"} disabled={Boolean(busy)} title="Three WebView" description={tr(locale, "构建独立 Windows 客户端，发布后直接下载 EXE。", "Build a standalone Windows client and download the EXE after publishing.")} onClick={() => props.onClientTargetChange?.("three-webview")} />
            <ModeButton icon={<Cpu size={16} />} active={props.clientTarget === "deep-native"} disabled={Boolean(busy)} title="Deep Native" description={tr(locale, "服务端编译并验证 Native 窗口，通过后下载 Windows 原生运行包。", "Compile and verify a Native window on the server, then download the Windows runtime package.")} onClick={() => props.onClientTargetChange?.("deep-native")} />
          </div>
          {props.mode === "cloud" && props.cloudConfigured !== true && props.cloudHint && (
            <div className="publication-cloud-hint" role="note">
              <Cloud size={14} /><span>{props.cloudHint}</span>
            </div>
          )}
          {submitError && <ScenePublicationFailure message={submitError} sceneName={props.sceneName} locale={locale}
            {...(failureReport ? { report: failureReport } : {})} />}
          {props.artifacts && props.projectId && props.sceneId && <ScenePublicationArtifacts artifacts={props.artifacts} projectId={props.projectId} sceneId={props.sceneId} locale={locale} />}
          <div className="publication-safety-note" title={tr(locale, "发布版本支持历史恢复，运行状态可在交付工作台诊断", "Published versions can be restored and diagnosed in the delivery workspace")}>
            <ShieldCheck size={14} /><strong>{tr(locale, "发布不会覆盖草稿", "Publishing does not overwrite the draft")}</strong>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="button" disabled={busy} onClick={props.onCancel}>
            {tr(locale, "取消", "Cancel")}
          </button>
          <button
            className="button primary"
            disabled={busy || artifactBusy || (props.mode === "cloud" && props.cloudConfigured !== true)}
            title={artifactBusy ? tr(locale, "请等待当前打包完成，或先取消打包", "Wait for packaging to finish or cancel it first") : undefined}
            onClick={() => void submit()}
          >
            {busy ? <LoaderCircle className="spin" size={14} /> : <Rocket size={14} />}
            {tr(locale, "发布", "Publish")}
          </button>
        </div>
      </section>
    </div>
  );
}

function ModeButton(props: { active: boolean; disabled?: boolean; icon: React.ReactNode; title: string; description: string; onClick: () => void }) {
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
    </button>
  );
}

function cloudDescription(locale: AppLocale, configured: boolean | undefined): string {
  if (configured === undefined) return tr(locale, "正在检查云渲染配置…", "Checking cloud configuration…");
  if (!configured) return tr(locale, "需要管理员先完成云渲染配置", "An administrator must configure cloud rendering first");
  return tr(
    locale,
    "服务端 GPU 出图，适合超大场景与低配终端；需要稳定网络和已配置 Worker。",
    "Server GPU rendering for large scenes and thin clients; requires a stable network and configured worker."
  );
}
