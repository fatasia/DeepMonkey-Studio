import type { RevitRuntimeInfo, RvtConversionMode } from "@bim-studio/contracts";
import { REVIT_VERSION_STORAGE_KEY } from "../appDefaults";
import { translate as tr, type AppLocale } from "../i18n";

export interface RvtImportSettingsProps {
  locale: AppLocale;
  mode: RvtConversionMode;
  revitVersion: string;
  runtime: RevitRuntimeInfo;
  onModeChange: (mode: RvtConversionMode) => void;
  onRevitVersionChange: (version: string) => void;
}

/** RVT 专属选项：仅在导入任务或显式默认设置中出现。 */
export function RvtImportSettings(props: RvtImportSettingsProps) {
  return <div className="rvt-import-settings">
    <div className="rvt-route-switch" aria-label={tr(props.locale, "RVT 转换链路", "RVT conversion route")}>
      <span>{tr(props.locale, "转换方式", "Conversion")}</span>
      <button type="button" className={props.mode === "native-glb" ? "active" : ""} onClick={() => props.onModeChange("native-glb")}>
        <strong>{tr(props.locale, "原生 GLB", "Native GLB")}</strong>
        <small>{tr(props.locale, "快速 · 推荐", "Fast · Recommended")}</small>
      </button>
      <button type="button" className={props.mode === "ifc" ? "active" : ""} onClick={() => props.onModeChange("ifc")}>
        <strong>IFC</strong>
        <small>{tr(props.locale, "兼容备用", "Compatibility fallback")}</small>
      </button>
    </div>
    <label className="revit-version-select">
      <span>{tr(props.locale, "Revit 版本", "Revit version")}</span>
      <select value={props.revitVersion} onChange={(event) => {
        props.onRevitVersionChange(event.target.value);
        window.localStorage.setItem(REVIT_VERSION_STORAGE_KEY, event.target.value);
      }}>
        <option value="auto">{tr(props.locale, "自动匹配（推荐）", "Auto match (recommended)")}</option>
        {props.runtime.installations.map((item) => <option key={item.version} value={item.version}>
          Revit {item.version}{item.addinInstalled ? " · Ready" : ` · ${tr(props.locale, "需安装插件", "Add-in required")}`}
        </option>)}
      </select>
      <small>{props.runtime.installations.length > 0
        ? tr(props.locale, `检测到 ${props.runtime.installations.length} 个本机版本`, `${props.runtime.installations.length} local versions detected`)
        : tr(props.locale, "未检测到本机 Revit，将使用服务端转换能力", "No local Revit detected; server conversion will be used")}</small>
    </label>
  </div>;
}
