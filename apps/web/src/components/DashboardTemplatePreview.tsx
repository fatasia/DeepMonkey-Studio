import { memo, useMemo, useRef, type CSSProperties } from "react";
import type { DashboardDataWidgetNode, DashboardPageDocument } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import type { DashboardTemplateDefinition, DashboardTemplateTier } from "./dashboardTemplateTypes";
import { buildDashboardTemplateNodes } from "./dashboardTemplateLayoutBuilder";
import { CoverDefs, CoverScene, coverNodeContent } from "./dashboardTemplateCoverArt";
import { useDashboardTemplateCover } from "./dashboardTemplateCoverRuntime";
import "./DashboardTemplatePreview.css";

interface DashboardTemplatePreviewProps {
  locale: AppLocale;
  template: DashboardTemplateDefinition;
  page?: Pick<DashboardPageDocument, "width" | "height">;
  previewNodes?: DashboardDataWidgetNode[];
  previewTitle?: string;
  /** 商用分层徽章(行业包/标准);文案由调用方按 locale 给出,组件只负责展示。 */
  tier?: DashboardTemplateTier;
  tierLabel?: string;
}

/**
 * 与实际插入使用同一布局工厂;封面在真实版式的 frame 上渲染"净化图形本体"。
 * 首帧是 SVG 数据场景插画(即时、确定、可 SSR);卡片进入视口后由
 * dashboardTemplateCoverRuntime 的真实渲染管线(同一 widget 运行时 + 示例数据)
 * 截帧并淡入替换——封面即插入后的真实观感,SVG 永远保底回退。
 */
/** memo:模板库一次挂载全部模板卡(317),工作区状态抖动(连接状态等)不应触发全量 SVG 重对账。 */
export const DashboardTemplatePreview = memo(function DashboardTemplatePreview({ locale, template, page, previewNodes, previewTitle, tier, tierLabel }: DashboardTemplatePreviewProps) {
  const width = page?.width ?? 1920, height = page?.height ?? 1080;
  const nodes = useMemo(() => previewNodes ?? buildDashboardTemplateNodes(locale,
    { id: "preview", name: "preview", width, height, viewportFit: "contain", nodes: [] }, template, 0), [locale, template, width, height, previewNodes]);
  const title = previewTitle ?? (locale === "zh-CN" ? template.zh : template.en);
  const defsId = `${template.id}${previewNodes ? "-live" : ""}`;
  // 实时节点分支(行业包整页预览)已是真实渲染,无需封面截帧。
  const containerRef = useRef<HTMLDivElement>(null);
  const coverUrl = useDashboardTemplateCover(template, locale, containerRef, !previewNodes);
  return <div ref={containerRef} className="dashboard-template-card-preview template-layout-preview"
    style={{ "--template-accent": template.accent, "--template-surface": template.surface } as CSSProperties}
    aria-label={locale === "zh-CN" ? `${title}模板预览` : `${title} template preview`}>
    {tier && tierLabel && <span className={`dashboard-template-tier-badge${tier === "industry" ? " is-industry" : ""}`}>{tierLabel}</span>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} preserveAspectRatio="xMidYMid meet">
      <title>{previewNodes ? (locale === "zh-CN" ? `${title} · 页面结构` : `${title} · Page layout`) : (locale === "zh-CN" ? `${title} · 页面结构，数据待绑定` : `${title} · Layout, data not connected`)}</title>
      <CoverDefs id={defsId} />
      <CoverScene id={defsId} width={width} height={height} seed={`${defsId}:scene`} />
      {nodes.map(({ frame, widget }, index) => <g key={widget.key} data-template-node={widget.key} data-widget-type={widget.type}>
        <rect className="cover-node-bg" x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={10} />
        {coverNodeContent(widget.type, frame, {
          title: widget.title,
          unit: widget.unit ?? "",
          seed: `${defsId}:${index}:${widget.type}`,
          defsId,
          hero: widget.key.includes(".primary."),
        })}
        {/* 每个节点的顶部高光带:成品面板的玻璃反光(统一放在内容之上,极低不透明度) */}
        <rect className="cover-node-sheen" x={frame.x} y={frame.y} width={frame.width} height={Math.max(18, frame.height * 0.16)} rx={10} fill={`url(#cover-sheen-${defsId})`} />
      </g>)}
    </svg>
    {coverUrl && <img className="dashboard-template-cover-photo" src={coverUrl} alt="" aria-hidden="true" draggable={false} />}
  </div>;
});
