import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

export const TOPOLOGY_PALETTE_STORAGE_KEY = "bim-studio.topology-palette";
export const TOPOLOGY_INSPECTOR_STORAGE_KEY = "bim-studio.topology-inspector";

interface TopologyPanelTogglesProps {
  locale: AppLocale;
  paletteOpen: boolean;
  inspectorOpen: boolean;
  onPaletteToggle: () => void;
  onInspectorToggle: () => void;
}

/** 画布边缘的面板开关不占用顶栏，并保留完整的键盘与读屏语义。 */
export function TopologyPanelToggles(props: TopologyPanelTogglesProps) {
  const paletteLabel = props.paletteOpen ? tr(props.locale, "收起设备库", "Collapse device library") : tr(props.locale, "展开设备库", "Expand device library");
  const inspectorLabel = props.inspectorOpen ? tr(props.locale, "收起属性面板", "Collapse inspector") : tr(props.locale, "展开属性面板", "Expand inspector");
  return (
    <nav className="topology-editor__panel-toggles" aria-label={tr(props.locale, "拓扑工作区面板", "Topology workspace panels")}>
      <button className="is-left" type="button" aria-label={paletteLabel} title={paletteLabel} aria-pressed={props.paletteOpen} onClick={props.onPaletteToggle}>
        {props.paletteOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
      </button>
      <button className="is-right" type="button" aria-label={inspectorLabel} title={inspectorLabel} aria-pressed={props.inspectorOpen} onClick={props.onInspectorToggle}>
        {props.inspectorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
      </button>
    </nav>
  );
}
