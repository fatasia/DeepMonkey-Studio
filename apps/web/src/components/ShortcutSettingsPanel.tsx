import { useState } from "react";
import { Keyboard } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import {
  DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, effectiveShortcut,
  readShortcutOverrides, writeShortcutOverrides,
  type ShortcutAction, type ShortcutOverrides,
} from "../shortcuts/keymap";

const ACTION_LABELS: Record<ShortcutAction, [string, string]> = {
  "tool.select": ["选择工具", "Select tool"],
  "tool.translate": ["移动工具", "Move tool"],
  "tool.rotate": ["旋转工具", "Rotate tool"],
  "tool.scale": ["缩放工具", "Scale tool"],
  "camera.focus": ["适应全部", "Fit all"],
  "view.toggleGrid": ["切换网格", "Toggle grid"],
  "scene.undo": ["撤销", "Undo"],
  "scene.redo": ["重做", "Redo"],
};

/** 快捷键设置:键位表展示(用户覆盖标注)+重置全部;逐项改键为 M2。 */
export function ShortcutSettingsPanel({ locale }: { locale: AppLocale }) {
  const [overrides, setOverrides] = useState<ShortcutOverrides>(() =>
    typeof window === "undefined" ? {} : readShortcutOverrides(window.localStorage));
  const hasOverrides = Object.keys(overrides).length > 0;

  const resetAll = (): void => {
    if (typeof window !== "undefined") writeShortcutOverrides(window.localStorage, {});
    setOverrides({});
  };

  return (
    <section className="shortcut-settings" aria-label={tr(locale, "快捷键设置", "Keyboard shortcuts")}>
      <header className="system-panel-header">
        <Keyboard size={16} />
        <strong>{tr(locale, "快捷键", "Keyboard shortcuts")}</strong>
        {hasOverrides && (
          <button type="button" className="button ghost" onClick={resetAll}>
            {tr(locale, "恢复默认键位", "Reset to defaults")}
          </button>
        )}
      </header>
      <table className="shortcut-table">
        <thead>
          <tr>
            <th>{tr(locale, "动作", "Action")}</th>
            <th>{tr(locale, "键位", "Binding")}</th>
            <th>{tr(locale, "来源", "Source")}</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_ACTIONS.map((action) => {
            const [zh, en] = ACTION_LABELS[action];
            const binding = effectiveShortcut(action, overrides);
            const custom = overrides[action] !== undefined;
            return (
              <tr key={action}>
                <td>{locale === "zh-CN" ? zh : en}</td>
                <td className="shortcut-binding">{binding.toUpperCase()}</td>
                <td>{custom ? tr(locale, "自定义", "Custom") : tr(locale, "默认", "Default")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="shortcut-note">
        {tr(locale, "在文本输入框内键位不生效;改键与冲突检测随后续版本提供。", "Bindings are inactive inside text inputs; rebinding and conflict detection ship in a later release.")}
      </p>
    </section>
  );
}
