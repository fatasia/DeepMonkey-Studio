import { useId, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, FlaskConical, RotateCcw, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { copyDocumentationCode } from "./DocsCenterClipboard";
import {
  EXPERIMENTAL_FEATURES,
  buildExperimentalFeatureHref,
  experimentalFeatureDetail,
  experimentalFeatureLabel,
  readExperimentalFeatureStates,
  type ExperimentalFeatureSpec,
} from "../viewer/experimentalFeatures";
import "./ExperimentalFeaturesPanel.css";

/**
 * 实验性功能面板:集中呈现全部 opt-in URL 开关(名称/说明/当前态/开关控件),
 * 支持复制带参链接与应用重载。判定与链接语义来自 experimentalFeatures.ts
 * 注册表(与桥侧 toggle 函数逐字对拍);面板不改变任何引擎读取语义——
 * 开关在 Deep 后端创建时读取,应用即重载页面生效。
 */

type CopyState = "idle" | "copied" | "failed";

interface ExperimentalFeaturesPanelProps {
  locale: AppLocale;
  onClose: () => void;
}

export function ExperimentalFeaturesPanel({ locale, onClose }: ExperimentalFeaturesPanelProps) {
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(false);
  // 草稿态:以当前 URL 生效态为初值;「应用并重载」「复制链接」都以草稿为准。
  const [draft, setDraft] = useState<Record<string, boolean>>(() => readExperimentalFeatureStates(window.location.search));
  const [current, setCurrent] = useState<Record<string, boolean>>(() => readExperimentalFeatureStates(window.location.search));
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const enabledCount = useMemo(
    () => EXPERIMENTAL_FEATURES.filter((spec) => draft[spec.param]).length,
    [draft],
  );
  const dirty = EXPERIMENTAL_FEATURES.some((spec) => draft[spec.param] !== current[spec.param]);
  const draftHref = useMemo(
    () => buildExperimentalFeatureHref(window.location.href, draft),
    [draft],
  );
  const dependentOff = (spec: ExperimentalFeatureSpec): boolean =>
    spec.requires !== undefined && draft[spec.param] === true && draft[spec.requires.param] !== true;

  function toggle(param: string, next: boolean): void {
    setDraft((value) => ({ ...value, [param]: next }));
  }

  async function copyLink(): Promise<void> {
    try {
      await copyDocumentationCode(draftHref);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function applyAndReload(): void {
    // 与「复制链接」同一条 URL 语义:重载后桥创建时读取,面板状态随之一致。
    window.location.href = draftHref;
  }

  function resetToCurrent(): void {
    const states = readExperimentalFeatureStates(window.location.search);
    setDraft({ ...states });
    setCurrent({ ...states });
  }

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className={`experimental-features-panel${collapsed ? " collapsed" : ""}`}
      aria-label={tr(locale, "实验性功能", "Experimental features")}
      data-collapsed={collapsed || undefined}
    >
      <header
        data-drag-handle="true"
        title={tr(locale, "拖动标题栏移动面板", "Drag the title bar to move the panel")}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        <span className="ef-title">
          <FlaskConical size={15} />
          <strong>{tr(locale, "实验性功能", "Experimental features")}</strong>
          <small className="ef-badge">{tr(locale, `${enabledCount}/${EXPERIMENTAL_FEATURES.length} 开启`, `${enabledCount}/${EXPERIMENTAL_FEATURES.length} on`)}</small>
          {dirty && <small className="ef-badge pending">{tr(locale, "待应用", "Pending")}</small>}
        </span>
        <span className="ef-actions">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? tr(locale, "展开", "Expand") : tr(locale, "折叠", "Collapse")}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" aria-label={tr(locale, "关闭", "Close")} title={tr(locale, "关闭", "Close")} onClick={onClose}>
            <X size={14} />
          </button>
        </span>
      </header>
      {!collapsed && (
        <div id={bodyId} className="ef-body">
          <p className="ef-intro">
            {tr(locale,
              "以下引擎开关只能经 URL 参数启用,这里集中列出便于发现与分享;勾选后「应用并重载」生效,或复制带参链接给他人。",
              "These engine switches are only reachable via URL parameters; this panel lists them for discovery. Apply and reload to take effect, or copy the link to share.")}
          </p>
          {featureGroup({
            locale,
            title: tr(locale, "渲染路径", "Rendering paths"),
            specs: EXPERIMENTAL_FEATURES.filter((spec) => spec.group === "rendering"),
            draft,
            dependentOff,
            onToggle: toggle,
          })}
          {featureGroup({
            locale,
            title: tr(locale, "调试与首帧", "Debug & first frame"),
            specs: EXPERIMENTAL_FEATURES.filter((spec) => spec.group === "debug"),
            draft,
            dependentOff,
            onToggle: toggle,
          })}
          <footer className="ef-footer">
            <button type="button" className="primary" disabled={!dirty} onClick={applyAndReload}
              title={tr(locale, "以当前勾选状态重载页面(开关在后端创建时读取)", "Reload with the current selection (switches are read when the backend is created)")}>
              {tr(locale, "应用并重载", "Apply & reload")}
            </button>
            <button type="button" onClick={() => void copyLink()}>
              {copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
              {copyState === "copied" ? tr(locale, "已复制", "Copied") : tr(locale, "复制带参链接", "Copy link")}
            </button>
            <button type="button" onClick={resetToCurrent} title={tr(locale, "放弃草稿,回到当前页面生效态", "Discard the draft and return to the applied state")}>
              <RotateCcw size={13} />
              {tr(locale, "还原", "Reset")}
            </button>
          </footer>
          <span role="status" className={copyState === "failed" ? "ef-copy-status failed" : "sr-only"}>
            {copyState === "failed"
              ? tr(locale, "复制失败:浏览器拒绝了剪贴板访问。", "Copy failed: the browser denied clipboard access.")
              : copyState === "copied"
                ? tr(locale, "链接已复制", "Link copied")
                : ""}
          </span>
          <p className="ef-footnote">
            {tr(locale,
              "开关由 Deep WebGPU 后端创建时读取,默认关闭的为实验性画质路径,不影响默认渲染逐位输出;依赖项未开时单项开启无效。",
              "Switches are read when the Deep WebGPU backend is created; opt-in paths are experimental and never change default output bit-exactness. Dependent switches need their requirement enabled.")}
          </p>
        </div>
      )}
    </div>
  );
}

/** 分组渲染:普通函数而非组件(无 hooks),返回元素供树遍历与测试直接展开。 */
function featureGroup({ locale, title, specs, draft, dependentOff, onToggle }: {
  locale: AppLocale;
  title: string;
  specs: readonly ExperimentalFeatureSpec[];
  draft: Record<string, boolean>;
  dependentOff: (spec: ExperimentalFeatureSpec) => boolean;
  onToggle: (param: string, next: boolean) => void;
}) {
  return (
    <section className="ef-group">
      <h3>{title}</h3>
      <ul>
        {specs.map((spec) => {
          const enabled = draft[spec.param] ?? false;
          const warning = dependentOff(spec);
          return (
            <li key={spec.param} className={warning ? "ef-row warn" : "ef-row"} data-testid={`ef-row-${spec.param}`}>
              <label className="ef-row-main">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => onToggle(spec.param, event.target.checked)}
                  aria-label={experimentalFeatureLabel(spec, locale)}
                />
                <span className="ef-row-text">
                  <strong>{experimentalFeatureLabel(spec, locale)}</strong>
                  <small>{experimentalFeatureDetail(spec, locale)}</small>
                  {warning && spec.requires && (
                    <small className="ef-row-warning">{experimentalFeatureDetail(
                      { ...spec, detail: spec.requires.note }, locale,
                    )}</small>
                  )}
                </span>
              </label>
              <code className="ef-param" title={tr(locale, "URL 参数", "URL parameter")}>{spec.param}</code>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
