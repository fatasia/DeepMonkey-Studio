import { useState } from "react";
import { Box, ChevronDown, Download, FileJson, Package } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

interface SceneExportMenuProps {
  onExportLoose: () => void;
  locale: AppLocale;
  onExportSingle: () => void;
  onExportGlb: () => void;
  onExportFbx: () => void;
  compact?: boolean;
  disabled?: boolean;
}

export function SceneExportMenu({ locale, onExportLoose, onExportSingle, onExportGlb, onExportFbx, compact = false, disabled = false }: SceneExportMenuProps) {
  const [open, setOpen] = useState(false);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div
      className={`export-menu ${compact ? "compact" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className={compact ? "" : "button ghost"}
        aria-label={tr(locale, "导出场景", "Export scene")}
        title={tr(locale, "导出场景", "Export scene")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Download size={compact ? 15 : 16} />{!compact && <><span>{tr(locale, "导出", "Export")}</span><ChevronDown size={13} /></>}
      </button>
      {open && (
        <div className="export-menu-popup" role="menu">
          <button role="menuitem" onClick={() => run(onExportLoose)}>
            <FileJson size={16} /><span><strong>{tr(locale, "场景 JSON", "Scene JSON")}</strong><small>{tr(locale, "仅配置，引用项目模型", "Configuration only; references project models")}</small></span>
          </button>
          <button role="menuitem" onClick={() => run(onExportSingle)}>
            <Package size={16} /><span><strong>{tr(locale, "单文件场景", "Single-file scene")}</strong><small>{tr(locale, "包含可浏览模型资源", "Includes viewable model assets")}</small></span>
          </button>
          <button role="menuitem" onClick={() => run(onExportGlb)}>
            <Box size={16} /><span><strong>{tr(locale, "完整场景 GLB", "Complete scene GLB")}</strong><small>{tr(locale, "几何、材质、纹理、层级与兼容动画", "Geometry, materials, textures, hierarchy and compatible animation")}</small></span>
          </button>
          <button role="menuitem" onClick={() => run(onExportFbx)}>
            <Box size={16} /><span><strong>{tr(locale, "FBX 文件", "FBX file")}</strong><small>{tr(locale, "可见网格、变换与基础材质", "Visible meshes, transforms and basic materials")}</small></span>
          </button>
        </div>
      )}
    </div>
  );
}
