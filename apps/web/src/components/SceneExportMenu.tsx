import { useState } from "react";
import { Box, ChevronDown, Download, FileJson, Package } from "lucide-react";

interface SceneExportMenuProps {
  onExportLoose: () => void;
  onExportSingle: () => void;
  onExportGlb: () => void;
  compact?: boolean;
  disabled?: boolean;
}

export function SceneExportMenu({ onExportLoose, onExportSingle, onExportGlb, compact = false, disabled = false }: SceneExportMenuProps) {
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
        title={compact ? "导出场景" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Download size={compact ? 15 : 16} />{!compact && <><span>导出</span><ChevronDown size={13} /></>}
      </button>
      {open && (
        <div className="export-menu-popup" role="menu">
          <button role="menuitem" onClick={() => run(onExportLoose)}>
            <FileJson size={16} /><span><strong>场景 JSON</strong><small>仅配置，引用项目模型</small></span>
          </button>
          <button role="menuitem" onClick={() => run(onExportSingle)}>
            <Package size={16} /><span><strong>单文件场景</strong><small>包含可浏览模型资源</small></span>
          </button>
          <button role="menuitem" onClick={() => run(onExportGlb)}>
            <Box size={16} /><span><strong>GLB 单文件</strong><small>合并当前可见三维对象</small></span>
          </button>
        </div>
      )}
    </div>
  );
}
