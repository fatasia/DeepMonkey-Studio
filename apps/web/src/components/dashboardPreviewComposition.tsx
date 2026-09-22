import { PreviewShell } from "./dashboardPreviewShared";
import { useDashboardPreviewGradientId as useGradientId } from "./dashboardComponentPreviewSvg";

/**
 * 媒体 / 3D / 拓扑类不再用裸图标占位，而是“渐变底 + 图形组合”的构图示意，
 * 让用户在插入前就能读出组件的视觉形态（对标外部参考素材库质感）。
 */
export function CompositionPreview({ kind }: { kind: "scene" | "topology" | "image" | "video" | "monitor" | "url" | "unity" }) {
  const topId = useGradientId("cp");
  const content = (() => {
    switch (kind) {
      case "scene":
      case "unity":
        return <>
          <defs>
            <linearGradient id={`${topId}t`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="stop-accent-strong" />
              <stop offset="1" className="stop-accent-mid" />
            </linearGradient>
            <linearGradient id={`${topId}l`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="stop-secondary-strong" />
              <stop offset="1" className="stop-secondary-ghost" />
            </linearGradient>
          </defs>
          <ellipse className="ground" cx="48" cy="50" rx="21" ry="4" />
          {kind === "unity" && <ellipse className="orbit" cx="48" cy="30" rx="26" ry="10" />}
          <g className="cube">
            <path className="face-top" fill={`url(#${topId}t)`} d="M48 12L63 20 48 28 33 20Z" />
            <path className="face-left" fill={`url(#${topId}l)`} d="M33 20L48 28V46L33 38Z" />
            <path className="face-right" d="M63 20L48 28V46L63 38Z" />
          </g>
        </>;
      case "topology":
        return <>
          <g className="edges"><path d="M48 28L25 15M48 28L73 13M48 28L21 44M48 28L72 45M25 15L73 13" /></g>
          <g className="halo"><circle cx="48" cy="28" r="9.5" /></g>
          <g className="nodes">
            <circle cx="25" cy="15" r="3" /><circle cx="73" cy="13" r="3" />
            <circle cx="21" cy="44" r="3" /><circle cx="72" cy="45" r="3" />
          </g>
          <g className="hub"><circle cx="48" cy="28" r="5.4" /><circle className="ring" cx="48" cy="28" r="9" /></g>
          <path className="link-active" d="M48 28L72 45" />
        </>;
      case "image":
        return <>
          <rect className="frame" x="15" y="10" width="66" height="44" rx="4" />
          <path className="photo" d="M17 46L36 25 47 37 59 24 79 46V51.5H17Z" />
          <circle className="sun" cx="68" cy="20" r="4" />
          <path className="photo-glint" d="M22 14L34 12" />
        </>;
      case "video":
        return <>
          <rect className="frame screen" x="16" y="9" width="64" height="40" rx="4" />
          <circle className="play-halo" cx="48" cy="29" r="11" />
          <circle className="play" cx="48" cy="29" r="8.4" />
          <path className="play-tri" d="M45.4 24.6L53.4 29 45.4 33.4Z" />
          <path className="progress-track" d="M20 53H76" />
          <path className="progress-fill" d="M20 53H50" />
          <circle className="playhead" cx="50" cy="53" r="2.2" />
        </>;
      case "monitor":
        return <>
          <g className="grid-cells">
            <rect x="15" y="9" width="31" height="20" rx="2.5" />
            <rect x="50" y="9" width="31" height="20" rx="2.5" />
            <rect x="15" y="33" width="31" height="20" rx="2.5" />
            <rect x="50" y="33" width="31" height="20" rx="2.5" />
          </g>
          <path className="cam-sweep" d="M55 14L72 24" />
          <g className="rec"><circle cx="76" cy="14" r="2.2" /></g>
          <path className="timeline" d="M19 54H60" />
        </>;
      case "url":
        return <>
          <rect className="frame" x="14" y="9" width="68" height="46" rx="4" />
          <path className="chrome-bar" d="M14 19H82" />
          <circle className="dot dot-a" cx="20" cy="14" r="1.6" />
          <circle className="dot dot-b" cx="25.5" cy="14" r="1.6" />
          <circle className="dot dot-c" cx="31" cy="14" r="1.6" />
          <rect className="addr" x="38" y="11.6" width="34" height="5" rx="2" />
          <rect className="hero" x="20" y="25" width="42" height="12" rx="2" />
          <path className="line" d="M20 43H66M20 49H52" />
        </>;
    }
  })();
  return <PreviewShell variant={`icon media composition composition-${kind}`}>
    <svg viewBox={COMPOSITION_VIEWBOX[kind]} aria-hidden="true">{content}</svg>
  </PreviewShell>;
}

/** 每类构图示意按主体收紧视窗,让图形放大占满瓷砖(外部参考“模型居中构图”)。 */
const COMPOSITION_VIEWBOX: Record<"scene" | "topology" | "image" | "video" | "monitor" | "url" | "unity", string> = {
  scene: "24 6 50 52",
  unity: "18 4 58 54",
  topology: "14 7 68 46",
  image: "12 7 72 50",
  video: "13 6 70 52",
  monitor: "12 6 72 52",
  url: "11 6 74 52",
};
