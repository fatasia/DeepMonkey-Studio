import { useState } from "react";
import { ExternalLink, PanelLeft, PanelRight, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

type DashboardSide = "left" | "right";

export function SceneDashboardOverlay({ locale, onClose }: { locale: AppLocale; onClose: () => void }) {
  const [side, setSide] = useState<DashboardSide>(() => window.localStorage.getItem("bim-studio.dashboard-side") === "left" ? "left" : "right");
  const [width, setWidth] = useState(() => Math.min(560, Math.max(300, Number(window.localStorage.getItem("bim-studio.dashboard-width")) || 380)));

  function changeSide(next: DashboardSide) {
    setSide(next);
    window.localStorage.setItem("bim-studio.dashboard-side", next);
  }

  function changeWidth(next: number) {
    setWidth(next);
    window.localStorage.setItem("bim-studio.dashboard-width", String(next));
  }

  return <section className={`scene-dashboard-overlay ${side}`} style={{ width }} aria-label={tr(locale, "场景二维看板", "Scene dashboard")}>
    <header>
      <div><strong>{tr(locale, "实时看板", "Live dashboard")}</strong><small>Node-RED · FlowFuse</small></div>
      <nav>
        <button className={side === "left" ? "active" : ""} title={tr(locale, "固定到左侧", "Dock left")} onClick={() => changeSide("left")}><PanelLeft size={14} /></button>
        <button className={side === "right" ? "active" : ""} title={tr(locale, "固定到右侧", "Dock right")} onClick={() => changeSide("right")}><PanelRight size={14} /></button>
        <a href="/node-red" target="_blank" rel="noreferrer" title={tr(locale, "编辑看板流程", "Edit dashboard flow")}><ExternalLink size={14} /></a>
        <button title={tr(locale, "关闭", "Close")} onClick={onClose}><X size={15} /></button>
      </nav>
    </header>
    <iframe title={tr(locale, "Node-RED 实时看板", "Node-RED live dashboard")} src="/iot/dashboard/overview?embed=1" />
    <label className="dashboard-width"><span>{tr(locale, "宽度", "Width")}</span><input type="range" min="300" max="560" step="10" value={width} onChange={(event) => changeWidth(Number(event.target.value))} /><output>{width}px</output></label>
  </section>;
}
