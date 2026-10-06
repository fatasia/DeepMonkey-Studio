import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { useDismissableDetails } from "../hooks/useDismissableDetails";

export interface AiModeOption<M extends string> {
  id: M;
  label: string;
  icon: LucideIcon;
}

/**
 * 提问范围下拉(2026-10-06 UI 修复):原生 select 的系统级弹窗与平台观感割裂,
 * 改用平台统一的 details 弹层契约(useDismissableDetails,同 SceneRowMenu):
 * 触发器对齐平台 select 字段观感(令牌驱动,明暗主题自动跟随),
 * 弹层朝上展开(锚在输入框工具栏,下方无空间),项带模式图标与选中态。
 */
export function AiModeSelect<M extends string>({ locale, value, options, disabled, onChange }: {
  locale: AppLocale;
  value: M;
  options: ReadonlyArray<AiModeOption<M>>;
  disabled?: boolean;
  onChange: (value: M) => void;
}) {
  const detailsRef = useDismissableDetails<HTMLDetailsElement>();
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const active = options.find((option) => option.id === value) ?? options[0];
  if (!active) return null;
  const ActiveIcon = active.icon;
  return (
    <details ref={detailsRef} className={`ai-scope-select${disabled ? " disabled" : ""}`}>
      <summary
        aria-label={t("提问范围", "Question scope")}
        aria-haspopup="listbox"
        title={t("提问范围：决定读取哪些证据", "Scope: decides which evidence is read")}
        onClick={(event) => { if (disabled) event.preventDefault(); }}
      >
        <ActiveIcon size={12} aria-hidden="true" />
        <span>{active.label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      <div className="ai-scope-select-popover" role="listbox" aria-label={t("提问范围", "Question scope")}>
        {options.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="option"
            aria-selected={id === value}
            className={id === value ? "active" : ""}
            disabled={disabled}
            onClick={() => {
              if (detailsRef.current) detailsRef.current.open = false;
              if (id !== value) onChange(id);
            }}
          >
            <Icon size={13} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </details>
  );
}
