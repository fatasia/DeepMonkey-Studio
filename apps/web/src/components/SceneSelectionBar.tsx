import { Eye, EyeOff, Focus, Group, Lock, MoreHorizontal, ScanLine, Unlock, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { useDismissableDetails } from "../hooks/useDismissableDetails";

export interface SceneSelectionBarObject {
  id: string;
}

/**
 * The compact selection actions are shared wherever the single scene layer
 * list is reused. Row-level visibility and locking stay on each row; this bar
 * prioritizes actions that only make sense for the complete selection.
 */
export function SceneSelectionBar({
  locale,
  selectedObjects,
  onGroup,
  onShow,
  onLock,
  onUnlock,
  onIsolate,
  onRestoreIsolation,
  isolationActive = false,
  onCollision,
  collisionEnabled = false,
  onClear,
}: {
  locale: AppLocale;
  selectedObjects: readonly SceneSelectionBarObject[];
  onGroup: () => void;
  onShow: (visible: boolean) => void;
  onLock: () => void;
  onUnlock?: () => void;
  onIsolate?: () => void;
  onRestoreIsolation?: () => void;
  isolationActive?: boolean;
  onCollision?: (enabled: boolean) => void;
  collisionEnabled?: boolean;
  onClear: () => void;
}) {
  const moreRef = useDismissableDetails<HTMLDetailsElement>();
  const ids = selectedObjects.map((item) => item.id);
  const hasSelection = ids.length > 0;
  if (ids.length < 2 && !(isolationActive && onRestoreIsolation)) return null;
  return (
    <div className="scene-tree-selection-bar visible">
      <span className="scene-selection-count">
        {tr(locale, "已选", "Selected")} <strong>{ids.length}</strong><small>{tr(locale, "批量", "Batch")}</small>
      </span>
      <button
        type="button"
        aria-label={tr(locale, "编组所选对象", "Group selection")}
        title={tr(locale, "编组", "Group")}
        disabled={ids.length < 2}
        onClick={onGroup}
      >
        <Group size={12} />
      </button>
      {onIsolate && <button
        type="button"
        aria-label={tr(locale, "隔离所选对象", "Isolate selection")}
        title={tr(locale, "隔离", "Isolate")}
        disabled={!hasSelection}
        onClick={onIsolate}
      >
        <Focus size={12} />
      </button>}
      {onCollision && <button
        type="button"
        className={collisionEnabled ? "active" : ""}
        aria-label={collisionEnabled ? tr(locale, "关闭所选对象碰撞", "Disable selection collision") : tr(locale, "开启所选对象碰撞", "Enable selection collision")}
        title={tr(locale, "碰撞", "Collision")}
        disabled={!hasSelection}
        onClick={() => onCollision(!collisionEnabled)}
      >
        <ScanLine size={12} />
      </button>}
      <details ref={moreRef} className="scene-selection-more">
        <summary aria-label={tr(locale, "更多所选对象操作", "More selection actions")} title={tr(locale, "更多操作", "More actions")}>
          <MoreHorizontal size={13} />
        </summary>
        <div className="scene-selection-more-popover" onClick={(event) => {
          const details = event.currentTarget.parentElement;
          if (details instanceof HTMLDetailsElement) details.open = false;
        }}>
          <button type="button" disabled={!hasSelection} onClick={() => onShow(true)}>
            <Eye size={13} /><span>{tr(locale, "显示所选对象", "Show selection")}</span>
          </button>
          <button type="button" disabled={!hasSelection} onClick={() => onShow(false)}>
            <EyeOff size={13} /><span>{tr(locale, "隐藏所选对象", "Hide selection")}</span>
          </button>
          <button type="button" disabled={!hasSelection} onClick={onLock}>
            <Lock size={13} /><span>{tr(locale, "锁定所选对象", "Lock selection")}</span>
          </button>
          {onRestoreIsolation && isolationActive && <button type="button" onClick={onRestoreIsolation}>
            <Eye size={13} /><span>{tr(locale, "恢复隔离前状态", "Restore isolation")}</span>
          </button>}
          {onUnlock && <button type="button" disabled={!hasSelection} onClick={onUnlock}>
            <Unlock size={13} /><span>{tr(locale, "解锁所选对象", "Unlock selection")}</span>
          </button>}
        </div>
      </details>
      <button
        type="button"
        aria-label={tr(locale, "清除选择", "Clear selection")}
        title={tr(locale, "清除选择", "Clear selection")}
        disabled={!hasSelection}
        onClick={onClear}
      >
        <X size={12} />
      </button>
    </div>
  );
}
