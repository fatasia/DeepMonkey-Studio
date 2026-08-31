import { useState } from "react";
import {
  ChevronRight,
  Eye,
  EyeOff,
  Footprints,
  Focus,
  Info,
  Layers3,
  ListTree,
  Maximize2,
  MoreHorizontal,
  Orbit,
  Ruler,
  ScanLine,
  UserRound,
} from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { NavigationMode } from "../viewer/ViewerEngine";
import type { StandardView } from "../viewer/ViewerEngine";
import { ToolButton } from "./AppFormControls";

interface PublishedViewerToolDockProps {
  locale: AppLocale;
  open: boolean;
  navigationMode: NavigationMode;
  measureEnabled: boolean;
  clippingEnabled: boolean;
  explosionActive: boolean;
  avatarVisible: boolean;
  infoEnabled: boolean;
  objectPanelOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onFitAll: () => void;
  onNavigationChange: (mode: NavigationMode) => void;
  onMeasurementToggle: () => void;
  onClippingToggle: () => void;
  onExplosionToggle: () => void;
  onAvatarToggle: () => void;
  onInfoToggle: () => void;
  onObjectPanelOpenChange: (open: boolean) => void;
  onStandardView: (view: StandardView) => void;
  onFullscreen: () => void;
  onStartXR: (mode: "immersive-vr" | "immersive-ar") => void;
}

/**
 * 发布页工具只改变当前观看会话，不会修改或保存场景快照。
 * 这个边界使公开浏览能提供工程查看能力，但不泄露编辑入口。
 */
export function PublishedViewerToolDock(props: PublishedViewerToolDockProps) {
  const { locale } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <div className={`tool-dock viewer-tool-dock ${props.open ? "open" : "collapsed"}`} role="toolbar" aria-label={tr(locale, "浏览工具", "Viewer tools")}>
      <button
        className="viewer-tool-toggle"
        type="button"
        aria-expanded={props.open}
        title={props.open ? tr(locale, "收起浏览工具", "Collapse viewer tools") : tr(locale, "展开浏览工具", "Expand viewer tools")}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <ChevronRight size={18} />
      </button>
      <div className="viewer-tool-items" aria-hidden={!props.open}>
        <ToolButton title={tr(locale, "适应全部（回到模型）", "Fit all")} active={false} onClick={props.onFitAll} icon={<Focus size={19} />} />
        <ToolButton title={tr(locale, "对象与属性", "Objects and properties")} active={props.objectPanelOpen} onClick={() => props.onObjectPanelOpenChange(!props.objectPanelOpen)} icon={<ListTree size={19} />} />
        <span className="viewer-tool-separator" />
        <ToolButton title={tr(locale, "测量标尺", "Measure")} active={props.measureEnabled} onClick={props.onMeasurementToggle} icon={<Ruler size={19} />} />
        <ToolButton title={tr(locale, "剖切查看", "Section view")} active={props.clippingEnabled} onClick={props.onClippingToggle} icon={<ScanLine size={19} />} />
        <ToolButton title={tr(locale, "模型爆炸", "Explode model")} active={props.explosionActive} onClick={props.onExplosionToggle} icon={<Layers3 size={19} />} />
        <span className="viewer-tool-separator" />
        <ToolButton title={tr(locale, "更多视图工具", "More view tools")} active={moreOpen} onClick={() => setMoreOpen((open) => !open)} icon={<MoreHorizontal size={19} />} />
      </div>
      {props.open && moreOpen && (
        <div className="viewer-tool-more" role="group" aria-label={tr(locale, "视图与漫游", "Views and navigation")}>
          <div>
            <strong>{tr(locale, "标准视图", "Standard views")}</strong>
            {(["top", "front", "right", "back"] as const).map((view) => (
              <button key={view} onClick={() => props.onStandardView(view)}>{standardViewLabel(locale, view)}</button>
            ))}
          </div>
          <div>
            <strong>{tr(locale, "漫游", "Navigation")}</strong>
            <ToolButton title={tr(locale, "轨道浏览", "Orbit")} active={props.navigationMode === "orbit"} onClick={() => props.onNavigationChange("orbit")} icon={<Orbit size={18} />} />
            <ToolButton title={tr(locale, "第一人称行走", "First-person walk")} active={props.navigationMode === "firstPerson"} onClick={() => props.onNavigationChange("firstPerson")} icon={<Footprints size={18} />} />
            <ToolButton title={tr(locale, "第三人称巡检", "Third-person inspect")} active={props.navigationMode === "thirdPerson"} onClick={() => props.onNavigationChange("thirdPerson")} icon={<UserRound size={18} />} />
          </div>
          <div>
            <strong>{tr(locale, "显示", "Display")}</strong>
            <ToolButton title={props.avatarVisible ? tr(locale, "隐藏人物", "Hide avatar") : tr(locale, "显示人物", "Show avatar")} active={props.avatarVisible} onClick={props.onAvatarToggle} icon={props.avatarVisible ? <Eye size={18} /> : <EyeOff size={18} />} />
            <ToolButton title={tr(locale, "场景信息", "Scene information")} active={props.infoEnabled} onClick={props.onInfoToggle} icon={<Info size={18} />} />
            <ToolButton title={tr(locale, "全屏浏览", "Fullscreen")} active={false} onClick={props.onFullscreen} icon={<Maximize2 size={18} />} />
            <ToolButton title={tr(locale, "进入 VR", "Enter VR")} active={false} onClick={() => props.onStartXR("immersive-vr")} icon={<span className="xr-tool-label">VR</span>} />
            <ToolButton title={tr(locale, "进入 AR", "Enter AR")} active={false} onClick={() => props.onStartXR("immersive-ar")} icon={<span className="xr-tool-label">AR</span>} />
          </div>
        </div>
      )}
    </div>
  );
}

function standardViewLabel(locale: AppLocale, view: "top" | "front" | "right" | "back"): string {
  const labels = { top: ["顶", "Top"], front: ["前", "Front"], right: ["右", "Right"], back: ["后", "Back"] } as const;
  return tr(locale, labels[view][0], labels[view][1]);
}
