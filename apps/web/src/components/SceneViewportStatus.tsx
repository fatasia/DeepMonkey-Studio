import { LoaderCircle, MapPin, ShieldCheck, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { MeasureMode, NavigationMode } from "../viewer/ViewerEngine";

export interface SceneStatisticsSummary {
  modelCount: number;
  componentCount: number;
  triangleCount: number;
  vertexCount: number;
}

export interface ViewerLoadProgress {
  phase: string;
  loaded: number;
  total: number;
  current: string;
}

interface SceneViewportStatusProps {
  locale: AppLocale;
  studio: boolean;
  measureControlsVisible: boolean;
  busy: boolean;
  message: string;
  infoEnabled: boolean;
  measureEnabled: boolean;
  annotationEnabled: boolean;
  measureMode: MeasureMode;
  navigationMode: NavigationMode;
  collisionEnabled: boolean;
  frameRate: number;
  statistics: SceneStatisticsSummary;
  viewerLoadState?: ViewerLoadProgress | undefined;
  brandLogoUrl: string;
  brandName: string;
  sceneName: string;
  onInfoClose: () => void;
  onMeasureModeChange: (mode: MeasureMode) => void;
  onMeasurementsClear: () => void;
  onAnnotationClose: () => void;
  onNavigationSettings: () => void;
  onNavigationExit: () => void;
}

export function SceneViewportStatus(props: SceneViewportStatusProps) {
  return (
    <>
      {!props.studio && props.infoEnabled && <ViewerInfoCard {...props} />}
      {props.measureControlsVisible && props.measureEnabled && (
        <MeasureModeBar
          locale={props.locale}
          value={props.measureMode}
          onChange={props.onMeasureModeChange}
          onClear={props.onMeasurementsClear}
        />
      )}
      {props.studio && props.annotationEnabled && (
        <div
          className="annotation-placement-bar"
          aria-label={tr(
            props.locale,
            "标签放置模式",
            "Annotation placement mode",
          )}
        >
          <MapPin size={15} />
          <strong>{tr(props.locale, "标签标记", "Annotation")}</strong>
          <span>
            {tr(
              props.locale,
              "点击模型表面或地面连续放置标签",
              "Click a model surface or ground to place annotations",
            )}
          </span>
          <small>
            {tr(
              props.locale,
              "放置后在右侧编辑",
              "Edit on the right after placement",
            )}
          </small>
          <button
            title={tr(
              props.locale,
              "退出标签放置",
              "Exit annotation placement",
            )}
            onClick={props.onAnnotationClose}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {props.studio && (
        <div className="viewport-status">
          <span className={props.busy ? "status-dot working" : "status-dot"} />
          {props.message}
        </div>
      )}
      {props.studio && props.navigationMode !== "orbit" && (
        <NavigationHint {...props} />
      )}
      {props.studio && props.busy && (
        <div className="loading-overlay">
          <LoaderCircle className="spin" size={24} />
          <span>{tr(props.locale, "正在处理模型", "Processing model")}</span>
        </div>
      )}
      {!props.studio && props.viewerLoadState && (
        <PublishedLoadState
          {...props}
          viewerLoadState={props.viewerLoadState}
        />
      )}
    </>
  );
}

function ViewerInfoCard(props: SceneViewportStatusProps) {
  const values = [
    [props.statistics.modelCount, tr(props.locale, "模型", "Models")],
    [props.statistics.componentCount, tr(props.locale, "构件", "Components")],
    [props.statistics.triangleCount, tr(props.locale, "三角面", "Triangles")],
    [props.statistics.vertexCount, tr(props.locale, "顶点", "Vertices")],
  ] as const;
  return (
    <section
      className="viewer-info-card"
      aria-label={tr(props.locale, "场景信息", "Scene information")}
    >
      <header>
        <strong>{tr(props.locale, "场景信息", "Scene information")}</strong>
        <button
          title={tr(props.locale, "关闭", "Close")}
          onClick={props.onInfoClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className="scene-info-grid">
        {values.map(([value, label]) => (
          <div key={label}>
            <strong>{value.toLocaleString()}</strong>
            <span>{label}</span>
          </div>
        ))}
        <div>
          <strong>{props.frameRate || "—"}</strong>
          <span>FPS</span>
        </div>
      </div>
    </section>
  );
}

function MeasureModeBar({
  locale,
  value,
  onChange,
  onClear,
}: {
  locale: AppLocale;
  value: MeasureMode;
  onChange: (mode: MeasureMode) => void;
  onClear: () => void;
}) {
  const modes: Array<[MeasureMode, string, string]> = [
    ["distance", "距离", "Distance"],
    ["minimum", "最小距离", "Minimum"],
    ["angle", "角度", "Angle"],
    ["elevation", "标高", "Elevation"],
  ];
  return (
    <div
      className="measure-mode-bar"
      aria-label={tr(locale, "测量模式", "Measurement mode")}
    >
      <span>{tr(locale, "测量", "Measure")}</span>
      {modes.map(([mode, zh, en]) => (
        <button
          key={mode}
          className={value === mode ? "active" : ""}
          onClick={() => onChange(mode)}
        >
          {tr(locale, zh, en)}
        </button>
      ))}
      <button onClick={onClear}>{tr(locale, "清除", "Clear")}</button>
      <small>
        {tr(locale, "Esc 取消当前起点", "Esc cancels the current start point")}
      </small>
    </div>
  );
}

function NavigationHint(props: SceneViewportStatusProps) {
  return (
    <div className="navigation-hint">
      <span
        className={`navigation-hint-status ${props.collisionEnabled ? "ready" : "warning"}`}
      >
        <ShieldCheck size={13} />
        {props.collisionEnabled
          ? tr(props.locale, "防穿模开启", "Collision on")
          : tr(props.locale, "防穿模关闭", "Collision off")}
      </span>
      <strong>
        {props.navigationMode === "firstPerson"
          ? tr(props.locale, "第一人称", "First person")
          : tr(props.locale, "第三人称", "Third person")}
      </strong>
      <span>
        {tr(
          props.locale,
          "W A S D 移动 · Shift 加速",
          "W A S D move · Shift boost",
        )}
        {props.navigationMode === "firstPerson"
          ? tr(
              props.locale,
              " · 空格跳跃 · 双击锁定",
              " · Space jump · Double-click to capture",
            )
          : tr(
              props.locale,
              " · Space / Ctrl 升降",
              " · Space / Ctrl altitude",
            )}
      </span>
      <button onClick={props.onNavigationSettings}>
        {tr(props.locale, "设置", "Settings")}
      </button>
      <button onClick={props.onNavigationExit}>
        {tr(props.locale, "退出", "Exit")}
      </button>
    </div>
  );
}

function PublishedLoadState(
  props: SceneViewportStatusProps & { viewerLoadState: ViewerLoadProgress },
) {
  const state = props.viewerLoadState;
  const percentage = state.total
    ? Math.round((state.loaded / state.total) * 100)
    : 100;
  const phaseLabel =
    state.phase === "essential"
      ? tr(props.locale, "正在准备首屏", "Preparing first view")
      : state.phase === "ready"
        ? tr(props.locale, "场景已可用", "Scene ready")
        : tr(props.locale, "正在渐进加载", "Streaming scene");
  return (
    <div className={`published-load-state ${state.phase}`}>
      <div className="published-load-brand">
        <img src={props.brandLogoUrl} alt="" />
        <span>
          <strong>{props.brandName}</strong>
          <small>{props.sceneName}</small>
        </span>
      </div>
      <div className="published-load-progress">
        <div>
          <span>{phaseLabel}</span>
          <strong>{percentage}%</strong>
        </div>
        <progress
          max={Math.max(1, state.total)}
          value={state.total ? state.loaded : 1}
        />
        <small>
          {state.current}
          {state.total > 0 ? ` · ${state.loaded}/${state.total}` : ""}
        </small>
      </div>
    </div>
  );
}
